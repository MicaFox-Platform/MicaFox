import { sql } from "kysely";

import { addOrgPolicy, CORE_MIGRATIONS, migrate } from "../../src/server/db/index.js";
import type { Database } from "../../src/server/db/index.js";
import { openTestDatabase, ORG_A, ORG_B } from "../db/test-database.js";
import type { TestDatabase } from "../db/test-database.js";

/** Opens the test database with hub-core's migrations and organizations A and B. */
export const openJobsDatabase = async (): Promise<TestDatabase> => {
  const test = await openTestDatabase({ migrated: true });
  await migrate(
    test.db,
    { url: test.ownerUrl ?? test.url, packages: [CORE_MIGRATIONS], log: test.logger },
    new AbortController().signal,
  );
  await test.db.system("test: add the organizations", async (trx) => {
    await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme'), (${ORG_B}, 'Globex')`.execute(trx);
  });
  return test;
};

/** Creates `events`, an organization's table with a time, under its organization policy. */
export const createEvents = async (db: Database): Promise<void> => {
  await sql`create table events (
    id serial primary key,
    org_id uuid not null,
    created_at timestamptz not null
  )`.execute(db.global);
  await addOrgPolicy(db.global, "events");
};

/** Adds `count` events of `orgId` at `at`. */
export const addEvents = async (db: Database, event: { orgId: string; at: Date; count: number }): Promise<void> => {
  await db.forOrg(event.orgId, async (trx) => {
    await sql`insert into events (org_id, created_at)
      select ${event.orgId}, ${event.at.toISOString()}::timestamptz from generate_series(1, ${event.count})`.execute(
      trx,
    );
  });
};

/** How many events each organization has, as `db.system` sees them. */
export const countEvents = async (db: Database): Promise<Record<string, number>> =>
  await db.system("test: count the events", async (trx) => {
    const { rows } = await sql<{
      orgId: string;
      count: number;
    }>`select org_id as "orgId", count(*)::int as count from events group by org_id`.execute(trx);
    return Object.fromEntries(rows.map((row) => [row.orgId, row.count]));
  });
