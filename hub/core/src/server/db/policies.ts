import { sql } from "kysely";
import type { Kysely } from "kysely";

import type { HubTables } from "./scope.js";

/** The name of the policy that keeps each organization's rows to itself. */
export const ORG_POLICY = "org_isolation";

// A setting an earlier transaction left empty on a pooled connection becomes NULL, which matches no row, instead of
// an empty string that fails the cast; `micafox.system` is set only by db.system()
const ROW_IS_VISIBLE = sql`org_id = nullif(current_setting('micafox.org_id', true), '')::uuid
  or current_setting('micafox.system', true) = 'on'`;

/**
 * Turns on row-level security for an organization's table: its `org_id` column decides who sees and writes a row.
 * `FORCE` applies the policy to the table's owner too, which is the app role when it runs the migrations.
 */
export const addOrgPolicy = async (db: Kysely<HubTables>, table: string): Promise<void> => {
  const name = sql.table(table);
  await sql`alter table ${name} enable row level security`.execute(db);
  await sql`alter table ${name} force row level security`.execute(db);
  await sql`create policy ${sql.id(ORG_POLICY)} on ${name} using (${ROW_IS_VISIBLE}) with check (${ROW_IS_VISIBLE})`.execute(
    db,
  );
};
