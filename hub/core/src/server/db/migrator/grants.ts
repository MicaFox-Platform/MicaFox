import { sql } from "kysely";
import type { Kysely } from "kysely";

import { HISTORY_PREFIX } from "./history.js";

/**
 * Gives the app role the rights to use what the migration role created. Tables belong to the migration role, so the
 * app role cannot alter them or switch their RLS off; it never gets the migration tables at all. Nothing to do
 * when both are the same role.
 */
export const grantToAppRole = async (db: Kysely<unknown>, appRole: string): Promise<void> => {
  const { rows: roles } = await sql<{ role: string }>`select current_user as role`.execute(db);
  if (roles[0]?.role === appRole) {
    return;
  }
  const role = sql.id(appRole);
  const { rows: tables } = await sql<{ name: string }>`
    select tablename as name from pg_tables
    where schemaname = 'public' and not starts_with(tablename, ${HISTORY_PREFIX})
  `.execute(db);
  for (const { name } of tables) {
    await sql`grant select, insert, update, delete on table ${sql.table(name)} to ${role}`.execute(db);
  }
  await sql`grant usage, select on all sequences in schema public to ${role}`.execute(db);
};
