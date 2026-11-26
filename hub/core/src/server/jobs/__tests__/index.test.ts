import { afterEach, describe, expect, it } from "vitest";

import { openJobsDatabase } from "../../../../test/db/jobs-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { emptyFeature } from "../../../../test/feature/fixtures.js";
import { createRecordingInstances } from "../../../../test/sdk-endpoint/recording-instances.js";
import { createEntitlements, createKeyUses } from "../../access/index.js";
import { createFeatureRegistry, createGate } from "../../feature/index.js";
import type { Feature } from "../../feature/index.js";
import { createJobs } from "../index.js";
import type { Jobs } from "../index.js";

const opened: TestDatabase[] = [];
const started: Jobs[] = [];

afterEach(async () => {
  await Promise.all(
    started.splice(0).map(async (jobs) => {
      await jobs.stop();
    }),
  );
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

const clock = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: NodeJS.Timeout) => {
    clearTimeout(handle);
  },
};

const build = async (features: readonly Feature[], retentionDays: Record<string, number> = {}) => {
  const test = await openJobsDatabase();
  opened.push(test);
  const registry = createFeatureRegistry(features, undefined);
  const gate = createGate(registry, createEntitlements({ sources: [], now: clock.now }));
  const jobs = createJobs({
    db: test.db,
    databaseUrl: "pglite:memory",
    registry,
    gate,
    retentionDays,
    log: test.logger,
    clock,
    keyUses: createKeyUses({ db: test.db, now: clock.now }),
    instances: createRecordingInstances(),
    sdk: {
      resend: async () => {
        await Promise.resolve();
      },
    },
  });
  started.push(jobs);
  return { test, jobs };
};

describe("createJobs", () => {
  it("runs nothing before start", async () => {
    let runs = 0;
    const { jobs } = await build([
      emptyFeature("debugger", {
        jobs: [
          {
            name: "expire",
            everyMs: 60_000,
            run: async () => {
              runs += 1;
              await Promise.resolve();
            },
          },
        ],
      }),
    ]);

    await jobs.stop();

    expect([runs, jobs.runs()]).toEqual([0, []]);
  });

  it("counts the runs of core jobs, feature jobs and retention policies by job and result", async () => {
    const reached = new Set<string>();
    let markAllReached = (): void => undefined;
    const allReached = new Promise<void>((resolve) => {
      markAllReached = resolve;
    });
    const mark = (name: string): void => {
      reached.add(name);
      if (reached.size === 3) {
        markAllReached();
      }
    };
    const { jobs } = await build([
      emptyFeature("debugger", {
        jobs: [
          {
            name: "ok-job",
            everyMs: 60_000,
            run: async () => {
              mark("ok-job");
              await Promise.resolve();
            },
          },
          {
            name: "bad-job",
            everyMs: 60_000,
            run: async () => {
              mark("bad-job");
              await Promise.reject(new Error("broke"));
            },
          },
        ],
        retention: [
          {
            name: "events",
            maxAgeDays: 30,
            run: async () => {
              mark("events");
              await Promise.resolve(0);
              return 0;
            },
          },
        ],
      }),
    ]);

    jobs.start();
    await allReached;
    await jobs.stop();

    expect(jobs.runs().sort((a, b) => a.job.localeCompare(b.job))).toEqual([
      { job: "bad-job", result: "failed", count: 1 },
      { job: "core.delete-stale-instances", result: "ok", count: 1 },
      { job: "core.expire-sessions", result: "ok", count: 1 },
      { job: "core.write-instances-last-seen", result: "ok", count: 1 },
      { job: "core.write-key-last-use", result: "ok", count: 1 },
      { job: "ok-job", result: "ok", count: 1 },
      { job: "retention.events", result: "ok", count: 1 },
    ]);
  });

  it("warns of a retention setting that no policy reads", async () => {
    const { test } = await build([], { snapshots: 3 });

    expect(test.log.lines().map((line) => line.setting)).toContain("MICAFOX_RETENTION_SNAPSHOTS_DAYS");
  });
});
