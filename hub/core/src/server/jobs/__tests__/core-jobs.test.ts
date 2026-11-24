import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openJobsDatabase } from "../../../../test/db/jobs-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { createCoreJobs } from "../core-jobs.js";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const DAY_MS = 24 * 60 * 60_000;
const USER_ID = "a0000000-0000-4000-8000-000000000001";
const neverAborted = new AbortController().signal;

const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

describe("createCoreJobs", () => {
  it("has one job that runs every hour", async () => {
    const test = await openJobsDatabase();
    opened.push(test);

    const jobs = createCoreJobs({ db: test.db, now: () => NOW });

    expect(jobs.map((job) => [job.name, job.everyMs])).toEqual([["core.expire-sessions", 3_600_000]]);
  });

  it("deletes the sessions unused for over 7 days or begun over 30 days ago, and keeps the others", async () => {
    const test = await openJobsDatabase();
    opened.push(test);
    const sessions = [
      { hash: "fresh", createdDaysAgo: 1, usedDaysAgo: 0 },
      { hash: "idle", createdDaysAgo: 10, usedDaysAgo: 8 },
      { hash: "old", createdDaysAgo: 31, usedDaysAgo: 0 },
      { hash: "week", createdDaysAgo: 20, usedDaysAgo: 6 },
    ];
    await test.db.system("test: add a user and sessions", async (trx) => {
      await sql`insert into users (id, email, name, password_hash) values (${USER_ID}, 'a@acme.test', 'A', 'hash')`.execute(
        trx,
      );
      for (const { hash, createdDaysAgo, usedDaysAgo } of sessions) {
        const created = new Date(NOW - createdDaysAgo * DAY_MS).toISOString();
        const used = new Date(NOW - usedDaysAgo * DAY_MS).toISOString();
        await sql`insert into sessions (token_hash, user_id, created_at, last_used_at)
          values (${hash}, ${USER_ID}, ${created}::timestamptz, ${used}::timestamptz)`.execute(trx);
      }
    });
    const [expire] = createCoreJobs({ db: test.db, now: () => NOW });

    await expire?.run(neverAborted);

    const kept = await test.db.system("test: read the sessions", async (trx) => {
      const { rows } = await sql<{
        tokenHash: string;
      }>`select token_hash as "tokenHash" from sessions order by 1`.execute(trx);
      return rows.map((row) => row.tokenHash);
    });
    expect(kept).toEqual(["fresh", "week"]);
  });
});
