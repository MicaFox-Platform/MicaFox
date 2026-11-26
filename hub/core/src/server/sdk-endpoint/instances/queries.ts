import { CamelCasePlugin, sql } from "kysely";
import type { Selectable, Transaction } from "kysely";

import type { InstanceFields } from "./fields.js";
import type { InstanceReply, ListRequest } from "./schemas.js";
import type { InstanceTables, InstancesTable } from "./tables.js";
import { DEFAULT_PAGE_LIMIT } from "../../../schema/index.js";
import { HttpProblem } from "../../app/index.js";
import type { HubTables } from "../../db/index.js";

/** An environment keeps at most this many instances once a new one connects: the oldest offline ones make room. */
export const MAX_INSTANCES_PER_ENVIRONMENT = 1000;

/** What the table needs to know of the session besides the `hello`. */
export interface InstanceOwner {
  orgId: string;
  projectId: string;
  environmentId: string;
  instanceId: string;
  keyPrefix: string;
}

/** What an accepted `hello` writes. */
export interface InstanceWrite {
  owner: InstanceOwner;
  fields: InstanceFields;
  /** The instances of the environment this replica holds a session for: none of them is deleted for the cap. */
  onlineIds: readonly string[];
  at: Date;
}

/** A page of instances: `nextCursor` is missing on the last one. */
export interface InstancePage {
  items: InstanceReply[];
  nextCursor?: string;
}

type Db = Transaction<InstanceTables>;
type InstanceRow = Selectable<InstancesTable>;

// Kysely types the tables of a query by name, and `HubTables` knows none; columns are `snake_case` in the database
const camelCase = new CamelCasePlugin();
const tables = (trx: Transaction<HubTables>): Db => trx.$extendTables<InstanceTables>().withPlugin(camelCase);

/**
 * Writes the instance of an accepted `hello`: a new row, or the old one with the fields of this connection. A new
 * instance beyond the cap of its environment deletes the oldest offline ones, never one of `onlineIds`.
 */
export const upsertInstance = async (trx: Transaction<HubTables>, write: InstanceWrite): Promise<void> => {
  const { owner, fields, at } = write;
  const { orgId, projectId, environmentId, instanceId } = owner;
  const values = {
    service: fields.service,
    labels: JSON.stringify(fields.labels),
    hostname: fields.hostname,
    pid: fields.pid,
    sdkName: fields.sdkName,
    sdkVersion: fields.sdkVersion,
    runtimeName: fields.runtimeName,
    runtimeVersion: fields.runtimeVersion,
    modules: fields.modules,
    commit: fields.commit,
    protocolVersion: fields.protocolVersion,
    keyPrefix: owner.keyPrefix,
    connectedAt: at,
    lastSeenAt: at,
  };
  // The fields of the latest hello win: a slower write of an older session of the instance changes nothing
  const written = await tables(trx)
    .insertInto("instances")
    .values({ orgId, projectId, environmentId, instanceId, ...values })
    .onConflict((conflict) =>
      conflict
        .columns(["environmentId", "instanceId"])
        .doUpdateSet(values)
        .where(sql<boolean>`instances.connected_at <= excluded.connected_at`),
    )
    .returning(sql<boolean>`xmax = 0`.as("inserted"))
    .executeTakeFirst();
  if (written?.inserted === true) {
    await deleteBeyondCap(trx, environmentId, write.onlineIds);
  }
};

// Keeps the environment to the cap by deleting its oldest offline instances; when all are online the table stays
// over it, bounded by the connection limits
const deleteBeyondCap = async (
  trx: Transaction<HubTables>,
  environmentId: string,
  onlineIds: readonly string[],
): Promise<void> => {
  const { rows } = await sql<{ count: number }>`
    select count(*)::int as count from instances where environment_id = ${environmentId}
  `.execute(trx);
  const excess = (rows[0]?.count ?? 0) - MAX_INSTANCES_PER_ENVIRONMENT;
  if (excess <= 0) {
    return;
  }
  await sql`
    delete from instances where (environment_id, instance_id) in (
      select environment_id, instance_id from instances
      where environment_id = ${environmentId} and not (instance_id = any(${[...onlineIds]}::text[]))
      order by last_seen_at, instance_id
      limit ${excess}
    )
  `.execute(trx);
};

/** Sets `last_seen_at` of the instances to `at`, in one statement. */
export const writeLastSeen = async (
  trx: Transaction<HubTables>,
  instances: ReadonlyArray<{ environmentId: string; instanceId: string }>,
  at: Date,
): Promise<void> => {
  await sql`
    update instances set last_seen_at = greatest(instances.last_seen_at, ${at.toISOString()}::timestamptz)
    from (
      select unnest(${instances.map((instance) => instance.environmentId)}::uuid[]) as environment_id,
        unnest(${instances.map((instance) => instance.instanceId)}::text[]) as instance_id
    ) as seen
    where instances.environment_id = seen.environment_id and instances.instance_id = seen.instance_id
  `.execute(trx);
};

/** Deletes the instances of every organization not seen since `cutoff`. */
export const deleteInstancesSeenBefore = async (trx: Transaction<HubTables>, cutoff: Date): Promise<void> => {
  await sql`delete from instances where last_seen_at < ${cutoff.toISOString()}::timestamptz`.execute(trx);
};

/** Whether the scoped organization has the environment. */
export const environmentExists = async (trx: Transaction<HubTables>, environmentId: string): Promise<boolean> => {
  const row = await tables(trx)
    .selectFrom("environments")
    .select("id")
    .where("id", "=", environmentId)
    .executeTakeFirst();
  return row !== undefined;
};

interface Cursor {
  rank: number;
  seenAt: string;
  id: string;
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const isCursor = (value: unknown): value is Cursor => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { rank, seenAt, id } = value as Record<string, unknown>;
  return (
    (rank === 0 || rank === 1) &&
    typeof seenAt === "string" &&
    Number.isFinite(Date.parse(seenAt)) &&
    typeof id === "string" &&
    !id.includes("\u0000")
  );
};

const invalidCursor = (): HttpProblem =>
  new HttpProblem("validation", {
    detail: "cursor: is not a cursor of this list",
    errors: [{ path: "/cursor", in: "query", message: "is not a cursor of this list" }],
  });

// A cursor this hub did not make, which would not survive the round trip or holds what Postgres refuses, is a 400
const decodeCursor = (text: string): Cursor => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString());
  } catch {
    throw invalidCursor();
  }
  if (!isCursor(parsed) || encodeCursor(parsed) !== text) {
    throw invalidCursor();
  }
  return parsed;
};

const toReply = (row: InstanceRow & { rank: number }): InstanceReply => ({
  id: row.instanceId,
  online: row.rank === 1,
  ...(row.service === null ? {} : { service: row.service }),
  labels: row.labels,
  hostname: row.hostname,
  pid: row.pid,
  sdk: { name: row.sdkName, version: row.sdkVersion },
  runtime: { name: row.runtimeName, version: row.runtimeVersion },
  modules: row.modules,
  ...(row.commit === null ? {} : { commit: row.commit }),
  protocolVersion: row.protocolVersion,
  keyPrefix: row.keyPrefix,
  connectedAt: row.connectedAt.toISOString(),
  lastSeenAt: row.lastSeenAt.toISOString(),
});

/**
 * The instances of an environment of the scoped organization: online ones first, then by last seen, newest first,
 * with the `instanceId` to break a tie. `onlineIds` are the ones this replica holds a session for. The cursor holds
 * where the last item sat, so an instance that goes online or offline between two pages may be seen twice or missed.
 */
export const listInstances = async (
  trx: Transaction<HubTables>,
  scope: { environmentId: string; onlineIds: readonly string[] },
  request: ListRequest,
): Promise<InstancePage> => {
  const { environmentId, onlineIds } = scope;
  // Validation fills in the default `limit`, which the type cannot know
  const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
  const rank = sql<number>`(instance_id = any(${[...onlineIds]}::text[]))::int`;
  let query = tables(trx)
    .selectFrom("instances")
    .selectAll()
    .select(rank.as("rank"))
    .where("environmentId", "=", environmentId)
    .orderBy(sql`${rank} desc`)
    .orderBy("lastSeenAt", "desc")
    .orderBy("instanceId")
    .limit(limit + 1);
  if (request.service !== undefined) {
    query = query.where("service", "=", request.service);
  }
  if (request.online !== undefined) {
    query = query.where(sql<boolean>`${rank} = ${request.online ? 1 : 0}`);
  }
  if (request.cursor !== undefined) {
    const after = decodeCursor(request.cursor);
    query = query.where(
      sql<boolean>`(${rank} < ${after.rank}
        or (${rank} = ${after.rank} and last_seen_at < ${after.seenAt}::timestamptz)
        or (${rank} = ${after.rank} and last_seen_at = ${after.seenAt}::timestamptz and instance_id > ${after.id}))`,
    );
  }
  const rows = await query.execute();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => toReply(row)),
    ...(rows.length > limit && last !== undefined
      ? { nextCursor: encodeCursor({ rank: last.rank, seenAt: last.lastSeenAt.toISOString(), id: last.instanceId }) }
      : {}),
  };
};
