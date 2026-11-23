import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { isOnPostgres, openTestDatabase } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";

const opened: TestDatabase[] = [];

const open = async (options: { poolSize?: number } = {}): Promise<TestDatabase> => {
  const test = await openTestDatabase(options);
  opened.push(test);
  return test;
};

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

describe("createDatabase", () => {
  it("returns int8, date and interval as the text Postgres sends, on Postgres and on PGlite alike", async () => {
    const { db } = await open();

    const { rows } = await sql<Record<string, unknown>>`
      select count(*) as count, date '2026-11-22' as day, interval '1 day' as span
    `.execute(db.global);

    expect(rows).toEqual([{ count: "1", day: "2026-11-22", span: "1 day" }]);
  });
});

// PGlite has one connection: what follows needs several, so it runs only on Postgres, in CI
describe.runIf(isOnPostgres)("createDatabase on Postgres", () => {
  it("warns, instead of crashing the hub, when the server drops an idle pooled connection", async () => {
    const { db, nextWarning } = await open({ poolSize: 2 });
    await Promise.all([sql`select 1`.execute(db.global), sql`select 1`.execute(db.global)]);
    const warned = nextWarning();

    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and usename = current_user and pid <> pg_backend_pid()
    `.execute(db.global);

    await expect(warned).resolves.toMatchObject({ key: "db.idle-connection" });
  });
});
