import { sql } from "kysely";
import { randomUUID } from "node:crypto";

import type { KeyScope } from "../../src/server/access/index.js";
import type { Database } from "../../src/server/db/index.js";

/** A project and an environment of `orgId`, with the key scope of a project key that leads to them. */
export const addEnvironment = async (db: Database, orgId: string): Promise<KeyScope> => {
  const projectId = randomUUID();
  const environmentId = randomUUID();
  await db.system("test: add an environment", async (trx) => {
    await sql`insert into projects (id, org_id, name) values (${projectId}, ${orgId}, ${projectId})`.execute(trx);
    await sql`insert into environments (id, org_id, project_id, name)
      values (${environmentId}, ${orgId}, ${projectId}, 'production')`.execute(trx);
  });
  return { keyId: randomUUID(), prefix: "mfx_pk_abcd", orgId, projectId, environmentId };
};

/** What a test reads of an instance row. */
export interface InstanceRow {
  instanceId: string;
  service: string | null;
  hostname: string;
  labels: Record<string, string>;
  modules: string[];
  keyPrefix: string;
  connectedAt: string;
  lastSeenAt: string;
}

/** The instances of an environment, by `instanceId`. */
export const readInstances = async (db: Database, environmentId: string): Promise<InstanceRow[]> =>
  await db.system("test: read instances", async (trx) => {
    const { rows } = await sql<{
      instanceId: string;
      service: string | null;
      hostname: string;
      labels: Record<string, string>;
      modules: string[];
      keyPrefix: string;
      connectedAt: Date | string;
      lastSeenAt: Date | string;
    }>`select instance_id as "instanceId", service, hostname, labels, modules, key_prefix as "keyPrefix",
        connected_at as "connectedAt", last_seen_at as "lastSeenAt"
      from instances where environment_id = ${environmentId} order by instance_id`.execute(trx);
    return rows.map((row) => ({
      ...row,
      connectedAt: new Date(row.connectedAt).toISOString(),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    }));
  });

/** Adds `count` offline instances named `<prefix>-0000`…, the first seen at `firstSeenAt`, each a second after the last. */
export const addOfflineInstances = async (
  db: Database,
  scope: Pick<KeyScope, "orgId" | "projectId" | "environmentId">,
  options: { count: number; firstSeenAt: Date; prefix?: string },
): Promise<void> => {
  await db.system("test: add offline instances", async (trx) => {
    await sql`insert into instances (org_id, project_id, environment_id, instance_id, hostname, pid, sdk_name,
        sdk_version, runtime_name, runtime_version, protocol_version, key_prefix, connected_at, last_seen_at)
      select ${scope.orgId}, ${scope.projectId}, ${scope.environmentId},
        ${options.prefix ?? "i"} || '-' || lpad(n::text, 4, '0'), 'host', 1, 'sdk', '1', 'node', '22', 1, 'mfx_pk_abcd',
        ${options.firstSeenAt.toISOString()}::timestamptz + n * interval '1 second',
        ${options.firstSeenAt.toISOString()}::timestamptz + n * interval '1 second'
      from generate_series(0, ${options.count - 1}) as n`.execute(trx);
  });
};
