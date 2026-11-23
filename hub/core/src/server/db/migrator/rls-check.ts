import { sql } from "kysely";
import type { Kysely } from "kysely";

import { HISTORY_PREFIX } from "./history.js";

/** Tables hold another organization's rows without `org_id`, or without row-level security enabled and forced. */
export class UnprotectedTablesError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(
      `These tables have no org_id with row-level security enabled and forced, and are not global tables: ${tables.join(", ")}`,
    );
    this.name = "UnprotectedTablesError";
  }
}

interface TableRow {
  tableName: string;
  hasOrgId: boolean;
  isProtected: boolean;
}

/** Fails, naming them, when a table of `public` outside `globalTables` lacks `org_id`, or RLS enabled and forced. */
export const checkRowLevelSecurity = async (db: Kysely<unknown>, globalTables: readonly string[]): Promise<void> => {
  const { rows } = await sql<TableRow>`
    select c.relname as "tableName",
      exists (
        select from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped
      ) as "hasOrgId",
      c.relrowsecurity and c.relforcerowsecurity as "isProtected"
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not starts_with(c.relname, ${HISTORY_PREFIX})
    order by c.relname
  `.execute(db);
  const global = new Set(globalTables);
  const unprotected = rows.filter((row) => !global.has(row.tableName) && !(row.hasOrgId && row.isProtected));
  if (unprotected.length > 0) {
    throw new UnprotectedTablesError(unprotected.map((row) => row.tableName));
  }
};
