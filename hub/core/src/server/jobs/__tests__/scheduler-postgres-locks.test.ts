import { afterEach, describe, expect, it } from "vitest";

import { isOnPostgres, openTestDatabase } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { createPostgresLocks } from "../advisory-lock.js";
import type { JobLocks } from "../advisory-lock.js";
import { createRunCounts } from "../run-counts.js";
import { createScheduler } from "../scheduler.js";
import type { JobClock, ScheduledJob } from "../scheduler.js";

const clock: JobClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

describe("createScheduler on Postgres locks", () => {
  // Two schedulers stand for two replicas; PGlite has one session, so only Postgres can prove it
  it.runIf(isOnPostgres)("skips the run of a job that another scheduler is running", async () => {
    const test = await openTestDatabase();
    opened.push(test);
    const realLocks = createPostgresLocks(test.url, test.logger);
    let markRunning = (): void => undefined;
    const firstIsRunning = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const job: ScheduledJob = {
      name: "expire",
      everyMs: 60_000,
      run: async (signal) => {
        markRunning();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
      },
    };
    const first = createScheduler({
      jobs: [job],
      locks: realLocks,
      counts: createRunCounts(),
      log: test.logger,
      clock,
    });
    first.start();
    await firstIsRunning;

    let markTried = (): void => undefined;
    const secondTried = new Promise<void>((resolve) => {
      markTried = resolve;
    });
    const secondLocks: JobLocks = {
      tryLock: async (name) => {
        const held = await realLocks.tryLock(name);
        markTried();
        return held;
      },
    };
    const secondCounts = createRunCounts();
    const second = createScheduler({ jobs: [job], locks: secondLocks, counts: secondCounts, log: test.logger, clock });
    second.start();
    await secondTried;
    await second.stop();
    await first.stop();

    expect(secondCounts.list()).toEqual([{ job: "expire", result: "skipped", count: 1 }]);
  });
});
