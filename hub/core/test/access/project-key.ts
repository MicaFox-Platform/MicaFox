import { sql } from "kysely";
import { randomUUID } from "node:crypto";

import { hashToken } from "../../src/server/access/index.js";
import type { Database } from "../../src/server/db/index.js";

/**
 * A project key row of a new project and environment of `orgId`, for `token` and with `lastUsedAt` if given;
 * answers its id.
 */
export const addProjectKey = async (
  db: Database,
  key: { orgId: string; token?: string; lastUsedAt?: string },
): Promise<string> => {
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const keyId = randomUUID();
  const token = key.token ?? `mfx_pk_${keyId}`;
  await db.system("test: add a project key", async (trx) => {
    await sql`insert into projects (id, org_id, name) values (${projectId}, ${key.orgId}, ${projectId})`.execute(trx);
    await sql`insert into environments (id, org_id, project_id, name)
      values (${environmentId}, ${key.orgId}, ${projectId}, 'production')`.execute(trx);
    await sql`insert into credentials (id, kind, token_hash, display_prefix, name, org_id, project_id, environment_id,
      last_used_at)
      values (${keyId}, 'project-key', ${hashToken(token)}, ${token.slice(0, 12)}, 'ci', ${key.orgId}, ${projectId}, ${environmentId},
      ${key.lastUsedAt ?? null}::timestamptz)`.execute(trx);
  });
  return keyId;
};

/** When the key `keyId` was last used, as ISO 8601, or `null`. */
export const readLastUse = async (db: Database, keyId: string): Promise<string | null> =>
  await db.system("test: read a key's last use", async (trx) => {
    const { rows } = await sql<{ lastUsedAt: Date | string | null }>`
      select last_used_at as "lastUsedAt" from credentials where id = ${keyId}`.execute(trx);
    const value = rows[0]?.lastUsedAt ?? null;
    return value === null ? null : new Date(value).toISOString();
  });
