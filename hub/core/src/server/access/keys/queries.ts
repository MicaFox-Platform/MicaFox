import { CamelCasePlugin, sql } from "kysely";
import type { Kysely, Selectable, Transaction } from "kysely";

import type { KeyCredentialsTable, KeyTables } from "./tables.js";
import type { HubTables } from "../../db/index.js";

/** At most this many active keys per environment, so a key rotates by adding the new one before revoking the old. */
export const MAX_ACTIVE_KEYS = 5;

/** A key as the API answers it. */
export interface ProjectKey {
  id: string;
  name: string;
  prefix: string;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Where a key leads, and the prefix that names it in a log. */
export interface KeyScope {
  keyId: string;
  /** The first 12 characters of the token. */
  prefix: string;
  orgId: string;
  projectId: string;
  environmentId: string;
}

/** The environment a key is made for. */
export interface EnvironmentRef {
  id: string;
  orgId: string;
  projectId: string;
}

type Row = Selectable<KeyCredentialsTable>;

// Kysely types the tables of a query by name, and `HubTables` knows none yet; columns are `snake_case` in the database
const camelCase = new CamelCasePlugin();
const tables = (db: Kysely<HubTables>): Kysely<KeyTables> => db.$extendTables<KeyTables>().withPlugin(camelCase);

const toKey = (row: Row): ProjectKey => ({
  id: row.id,
  name: row.name,
  prefix: row.displayPrefix,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

const toScope = (row: Row): KeyScope => ({
  keyId: row.id,
  prefix: row.displayPrefix,
  orgId: row.orgId,
  projectId: row.projectId,
  environmentId: row.environmentId,
});

/**
 * The environment `id` of the scoped organization, locked until the transaction ends: two requests that add a key
 * to it wait for each other, so both cannot see room for the fifth. `NO KEY UPDATE` leaves the rows that reference
 * the environment free to be written meanwhile.
 */
export const lockEnvironment = async (trx: Transaction<HubTables>, id: string): Promise<EnvironmentRef | undefined> =>
  await tables(trx)
    .selectFrom("environments")
    .select(["id", "orgId", "projectId"])
    .where("id", "=", id)
    .forNoKeyUpdate()
    .executeTakeFirst();

/** The environment `id` of the scoped organization, or `undefined`. */
export const findEnvironment = async (trx: Transaction<HubTables>, id: string): Promise<EnvironmentRef | undefined> =>
  await tables(trx)
    .selectFrom("environments")
    .select(["id", "orgId", "projectId"])
    .where("id", "=", id)
    .executeTakeFirst();

/** How many active keys the environment holds. */
export const countActiveKeys = async (trx: Transaction<HubTables>, environment: EnvironmentRef): Promise<number> => {
  const row = await tables(trx)
    .selectFrom("credentials")
    .select((builder) => builder.fn.countAll<string>().as("count"))
    .where("kind", "=", "project-key")
    .where("orgId", "=", environment.orgId)
    .where("environmentId", "=", environment.id)
    .where("revokedAt", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
};

/** Stores a key: its hash and the first characters to show, never the token. */
export const insertKey = async (
  trx: Transaction<HubTables>,
  key: { environment: EnvironmentRef; name: string; tokenHash: string; displayPrefix: string; createdBy: string },
): Promise<ProjectKey> =>
  toKey(
    await tables(trx)
      .insertInto("credentials")
      .values({
        kind: "project-key",
        tokenHash: key.tokenHash,
        displayPrefix: key.displayPrefix,
        name: key.name,
        orgId: key.environment.orgId,
        projectId: key.environment.projectId,
        environmentId: key.environment.id,
        createdBy: key.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );

/** The active keys of an environment, oldest first. */
export const listActiveKeys = async (trx: Transaction<HubTables>, environment: EnvironmentRef): Promise<ProjectKey[]> =>
  (
    await tables(trx)
      .selectFrom("credentials")
      .selectAll()
      .where("kind", "=", "project-key")
      .where("orgId", "=", environment.orgId)
      .where("environmentId", "=", environment.id)
      .where("revokedAt", "is", null)
      .orderBy("createdAt")
      .orderBy("id")
      .execute()
  ).map((row) => toKey(row));

/** Where the active key `id` of organization `orgId` leads; `undefined` when it has none, or it was revoked. */
export const findActiveKey = async (
  trx: Transaction<HubTables>,
  orgId: string,
  id: string,
): Promise<KeyScope | undefined> => {
  const row = await tables(trx)
    .selectFrom("credentials")
    .selectAll()
    .where("kind", "=", "project-key")
    .where("id", "=", id)
    .where("orgId", "=", orgId)
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  return row === undefined ? undefined : toScope(row);
};

/** Revokes the active key `id` of organization `orgId`; `undefined` when it has none, or has been revoked already. */
export const revokeKey = async (
  trx: Transaction<HubTables>,
  orgId: string,
  id: string,
): Promise<KeyScope | undefined> => {
  const row = await tables(trx)
    .updateTable("credentials")
    .set({ revokedAt: sql<Date>`now()` })
    .where("kind", "=", "project-key")
    .where("id", "=", id)
    .where("orgId", "=", orgId)
    .where("revokedAt", "is", null)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toScope(row);
};

/** Finds the active key whose SHA-256 is `tokenHash`: the only way a key is looked up. */
export const findKeyByHash = async (db: Kysely<HubTables>, tokenHash: string): Promise<KeyScope | undefined> => {
  const row = await tables(db)
    .selectFrom("credentials")
    .selectAll()
    .where("kind", "=", "project-key")
    .where("tokenHash", "=", tokenHash)
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  return row === undefined ? undefined : toScope(row);
};

/**
 * Writes when keys were last used, in one statement; a time never moves a key's last use back, so two replicas may
 * write in any order.
 */
export const writeKeysLastUse = async (db: Kysely<HubTables>, uses: ReadonlyMap<string, number>): Promise<void> => {
  const ids = [...uses.keys()];
  const times = [...uses.values()].map((ms) => new Date(ms).toISOString());
  await sql`
    update credentials set last_used_at = greatest(credentials.last_used_at, used.at)
    from unnest(${ids}::uuid[], ${times}::timestamptz[]) as used (id, at)
    where credentials.kind = 'project-key' and credentials.id = used.id
  `.execute(db);
};
