import { Kysely, PostgresDialect } from "kysely";
import type { Dialect } from "kysely";
import pg from "pg";
import type { Logger } from "pino";

import { connectDatabase, probeRole } from "./connect.js";
import { createPgliteDialect } from "./pglite/index.js";
import { createScopes } from "./scope.js";
import type { Database, HubTables } from "./scope.js";
import { asText, TEXT_TYPE_IDS } from "./value-types.js";
import type { Timers } from "../observability/index.js";

export { DatabaseRoleError } from "./connect.js";
export { addOrgPolicy, ORG_POLICY } from "./policies.js";
export { APP_ROLE } from "./pglite/index.js";
export { NestedScopeError } from "./scope.js";
export type { Database, HubTables } from "./scope.js";

/** What the database needs from the settings and the hub. */
export interface DatabaseOptions {
  /** `postgres://…`, `pglite:memory` or `pglite:<folder>`. */
  url: string;
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

const pgliteDialectOf = (location: string, log: Logger): Dialect =>
  createPgliteDialect({
    ...(location === "memory" ? {} : { dataDir: location }),
    parsers: Object.fromEntries(TEXT_TYPE_IDS.map((id) => [id, asText])),
    onOpen: () => {
      log.warn(
        { database: `${PGLITE_PREFIX}${location}` },
        "The database is PGlite: for tests, the test mode and trials, not for production",
      );
    },
  });

/** Builds the database of a settings URL; nothing connects until the first query or `connect`. */
export const createDatabase = (options: DatabaseOptions): Database => {
  const dialect = options.url.startsWith(PGLITE_PREFIX)
    ? pgliteDialectOf(options.url.slice(PGLITE_PREFIX.length), options.log)
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
