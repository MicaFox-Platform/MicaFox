import type { PGlite } from "@electric-sql/pglite";
import { Kysely, PostgresDialect } from "kysely";
import type { Dialect } from "kysely";
import pg from "pg";
import pino from "pino";
import type { Logger } from "pino";

import { connectDatabase, probeRole } from "./connect.js";
import { CORE_MIGRATIONS, GLOBAL_TABLES } from "./migrations/index.js";
import { migrate as runMigrator } from "./migrator/index.js";
import type { MigrationPackage } from "./migrator/index.js";
import { createPgliteDialect, writeSeed } from "./pglite/index.js";
import type { PgliteOptions } from "./pglite/index.js";
import { createScopes } from "./scope.js";
import type { Database, HubTables } from "./scope.js";
import { asText, TEXT_TYPE_IDS } from "./value-types.js";
import type { Timers } from "../observability/index.js";

export { DatabaseRoleError } from "./connect.js";
export { CORE_MIGRATIONS } from "./migrations/index.js";
export { MigrationPackageError, UnknownMigrationError, UnprotectedTablesError } from "./migrator/index.js";
export type { Migration, MigrationPackage } from "./migrator/index.js";
export { addOrgPolicy, ORG_POLICY } from "./policies.js";
export { APP_ROLE } from "./pglite/index.js";
export { NestedScopeError } from "./scope.js";
export { hasUnstorable, replaceUnstorable } from "./storable-text.js";
export type { Database, HubTables } from "./scope.js";

/** What the database needs from the settings and the hub. */
export interface DatabaseOptions {
  /** `postgres://…`, `pglite:memory` or `pglite:<folder>`. */
  url: string;
  /** The migrated `.tar.gz` a `pglite:memory` or a new `pglite:<folder>` starts from; ignored on Postgres. */
  pgliteSeed?: string;
  poolSize: number;
  log: Logger;
  warnCollapsed: (key: string, fields: Record<string, unknown>, message: string) => void;
}

// A pool waits this long to connect, or for a free connection, before the query fails
const CONNECT_TIMEOUT_MS = 5000;
const PGLITE_PREFIX = "pglite:";

// Per pool, not pg's global parsers, so nothing else in the process changes
const textTypeOverrides = (): pg.TypeOverrides => {
  const overrides = new pg.TypeOverrides();
  for (const id of TEXT_TYPE_IDS) {
    overrides.setTypeParser(id, asText);
  }
  return overrides;
};

const createPostgresDialect = (options: DatabaseOptions): Dialect => {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolSize,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    types: textTypeOverrides(),
  });
  // A pooled connection that the server drops while idle emits here; unheard, it would crash the hub
  pool.on("error", (error) => {
    options.warnCollapsed("db.idle-connection", { err: error }, "An idle database connection failed");
  });
  return new PostgresDialect({ pool });
};

const pgliteDialectOf = (
  location: string,
  options: Pick<DatabaseOptions, "pgliteSeed" | "log">,
  onOpen: PgliteOptions["onOpen"] = () => undefined,
): Dialect =>
  createPgliteDialect({
    ...(location === "memory" ? {} : { dataDir: location }),
    ...(options.pgliteSeed === undefined ? {} : { seed: options.pgliteSeed }),
    parsers: Object.fromEntries(TEXT_TYPE_IDS.map((id) => [id, asText])),
    onOpen: (pglite) => {
      options.log.warn(
        { database: `${PGLITE_PREFIX}${location}` },
        "The database is PGlite: for tests, the test mode and trials, not for production",
      );
      onOpen(pglite);
    },
    onSeedMissing: (seed) => {
      options.log.warn({ seed }, "The PGlite seed is missing: the database starts empty and runs every migration");
    },
  });

/** Builds the database of a settings URL; nothing connects until the first query or `connect`. */
export const createDatabase = (options: DatabaseOptions): Database => {
  const dialect = options.url.startsWith(PGLITE_PREFIX)
    ? pgliteDialectOf(options.url.slice(PGLITE_PREFIX.length), options)
    : createPostgresDialect(options);
  return createScopes(new Kysely<HubTables>({ dialect }), options.log);
};

/** The hub's readiness step for the database: see `connectDatabase`. */
export const connect = async (
  db: Database,
  options: Pick<DatabaseOptions, "warnCollapsed"> & { timers: Timers },
  signal: AbortSignal,
): Promise<void> => {
  await connectDatabase({ probe: async () => await probeRole(db.global), ...options }, signal);
};

/** What the migrations step needs besides the database. */
export interface MigrateOptions extends Pick<DatabaseOptions, "log"> {
  /** `MICAFOX_MIGRATION_DATABASE_URL`, which is the database URL when not set. */
  url: string;
  /** hub-core's migrations first, then the features' and the extension's, in the app's order. */
  packages: readonly MigrationPackage[];
}

/** The hub's readiness step for the schema: see `migrate` in `migrator/`; it runs after `connect`. */
export const migrate = async (db: Database, options: MigrateOptions, signal: AbortSignal): Promise<void> => {
  const { role } = await probeRole(db.global);
  await runMigrator(
    {
      packages: options.packages,
      globalTables: GLOBAL_TABLES,
      appRole: role,
      url: options.url,
      session: options.url.startsWith(PGLITE_PREFIX) ? db.global : undefined,
      log: options.log,
    },
    signal,
  );
};

/** What `buildPgliteSeed` writes, and where it logs. */
export interface PgliteSeedOptions {
  /** The `.tar.gz` to write; its folder is created when missing. */
  file: string;
  /** Silent without it. */
  log?: Logger;
  /** The migrations of the features and the extension, in the app's order; hub-core's own always run first. */
  packages?: readonly MigrationPackage[];
}

/**
 * Runs every migration into a new PGlite in memory, with the RLS check and grants of a start, and saves its data
 * folder as the seed a `pglite:memory` or a new `pglite:<folder>` starts from.
 */
export const buildPgliteSeed = async (options: PgliteSeedOptions): Promise<void> => {
  const url = `${PGLITE_PREFIX}memory`;
  const log = options.log ?? pino({ level: "silent" });
  let onOpen: PgliteOptions["onOpen"] = () => undefined;
  // Settles when the migrations open PGlite through the dialect: the instance the seed is dumped from
  const opened = new Promise<PGlite>((resolve) => {
    onOpen = resolve;
  });
  const dialect = pgliteDialectOf("memory", { log }, onOpen);
  const db = createScopes(new Kysely<HubTables>({ dialect }), log);
  try {
    await migrate(
      db,
      { url, packages: [CORE_MIGRATIONS, ...(options.packages ?? [])], log },
      new AbortController().signal,
    );
    await writeSeed(await opened, options.file);
  } finally {
    await db.close();
  }
};
