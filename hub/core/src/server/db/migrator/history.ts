import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Each package records what it ran in `micafox_migrations_<package>`; the RLS check and the grants skip them. */
export const HISTORY_PREFIX = "micafox_migrations_";

const historyOf = (packageName: string): ReturnType<typeof sql.table> => sql.table(`${HISTORY_PREFIX}${packageName}`);

/** Creates the package's table of migrations run when it is missing. */
export const ensureHistory = async (db: Kysely<unknown>, packageName: string): Promise<void> => {
  await sql`create table if not exists ${historyOf(packageName)} (
    name text primary key,
    ran_at timestamptz not null default now()
  )`.execute(db);
};

/** The names of the migrations the package ran. */
export const readHistory = async (db: Kysely<unknown>, packageName: string): Promise<Set<string>> => {
  const { rows } = await sql<{ name: string }>`select name from ${historyOf(packageName)}`.execute(db);
  return new Set(rows.map((row) => row.name));
};

/** Records that the package ran the migration. */
export const recordMigration = async (db: Kysely<unknown>, packageName: string, name: string): Promise<void> => {
  await sql`insert into ${historyOf(packageName)} (name) values (${name})`.execute(db);
};
