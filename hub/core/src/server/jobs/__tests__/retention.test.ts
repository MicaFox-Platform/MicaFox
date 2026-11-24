import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { addEvents, countEvents, createEvents, openJobsDatabase } from "../../../../test/db/jobs-database.js";
import { ORG_A, ORG_B } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { emptyFeature, fixtureExtension, paidFeature } from "../../../../test/feature/fixtures.js";
import { createEntitlements } from "../../access/index.js";
import { createFeatureRegistry, createGate } from "../../feature/index.js";
import type { Feature, RetentionPolicy } from "../../feature/index.js";
import { OrgRunError } from "../for-each-org.js";
import { scheduleRetention, warnUnusedRetentionDays } from "../retention.js";
import type { RetentionParts } from "../retention.js";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const DAY_MS = 24 * 60 * 60_000;
const daysAgo = (days: number): Date => new Date(NOW - days * DAY_MS);
const neverAborted = new AbortController().signal;

const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

// Deletes one batch of the organization's events older than `olderThan`, as a feature's policy does
const deleteEvents: RetentionPolicy["run"] = async ({ orgId, olderThan, limit, db }) => {
  const { rows } = await sql<{ id: number }>`delete from events
    where id in (
      select id from events where org_id = ${orgId} and created_at < ${olderThan.toISOString()}::timestamptz limit ${limit}
    ) returning id`.execute(db);
  return rows.length;
};

const eventsPolicy = (overrides: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  name: "events",
  maxAgeDays: 30,
  run: deleteEvents,
  ...overrides,
});

interface Setup {
  test: TestDatabase;
  parts: RetentionParts;
  retention: ReturnType<typeof createFeatureRegistry>["retention"];
}

const setup = async (options: {
  features?: readonly Feature[];
  extension?: ReturnType<typeof fixtureExtension>;
  retentionDays?: Record<string, number>;
}): Promise<Setup> => {
  const test = await openJobsDatabase();
  opened.push(test);
  await createEvents(test.db);
  const registry = createFeatureRegistry(options.features ?? [], options.extension);
  const gate = createGate(registry, createEntitlements({ sources: [], now: () => NOW }));
  return {
    test,
    retention: registry.retention,
    parts: { db: test.db, gate, log: test.logger, retentionDays: options.retentionDays ?? {}, now: () => NOW },
  };
};

const firstPolicy = (retention: Setup["retention"]): Setup["retention"][number] => {
  const [first] = retention;
  if (first === undefined) {
    throw new Error("The fixture has no retention policy");
  }
  return first;
};

describe("scheduleRetention", () => {
  it("runs every hour under the policy's name", async () => {
    const { parts, retention } = await setup({ features: [emptyFeature("debugger", { retention: [eventsPolicy()] })] });

    const job = scheduleRetention(firstPolicy(retention), parts);

    expect([job.name, job.everyMs]).toEqual(["retention.events", 3_600_000]);
  });

  it("deletes what is older than the policy's days in every organization and keeps the rest", async () => {
    const { test, parts, retention } = await setup({
      features: [emptyFeature("debugger", { retention: [eventsPolicy()] })],
    });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(31), count: 2 });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(29), count: 1 });
    await addEvents(test.db, { orgId: ORG_B, at: daysAgo(40), count: 3 });

    await scheduleRetention(firstPolicy(retention), parts).run(neverAborted);

    expect(await countEvents(test.db)).toEqual({ [ORG_A]: 1 });
  });

  it("uses the days of MICAFOX_RETENTION_<NAME>_DAYS instead of the policy's", async () => {
    const { test, parts, retention } = await setup({
      features: [emptyFeature("debugger", { retention: [eventsPolicy()] })],
      retentionDays: { events: 7 },
    });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(10), count: 1 });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(5), count: 1 });

    await scheduleRetention(firstPolicy(retention), parts).run(neverAborted);

    expect(await countEvents(test.db)).toEqual({ [ORG_A]: 1 });
  });

  it("reads the days of a policy whose name has dashes from the setting with underscores", async () => {
    const { test, parts, retention } = await setup({
      features: [emptyFeature("debugger", { retention: [eventsPolicy({ name: "old-events" })] })],
      retentionDays: Object.fromEntries([["old_events", 1]]),
    });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(2), count: 1 });

    await scheduleRetention(firstPolicy(retention), parts).run(neverAborted);

    expect(await countEvents(test.db)).toEqual({});
  });

  it("deletes in batches, each in its own db.system transaction logged at debug, and logs one summary", async () => {
    const { test, parts, retention } = await setup({
      features: [emptyFeature("debugger", { retention: [eventsPolicy()] })],
    });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(40), count: 2500 });

    await scheduleRetention(firstPolicy(retention), parts).run(neverAborted);

    // Three batches for the organization that has events, one that finds nothing for the other
    const batches = test.log.lines().filter((line) => line.reason === "retention events");
    const summary = test.log.lines().filter((line) => line.msg === "Retention deleted old rows");
    expect([await countEvents(test.db), batches.map((line) => line.level), summary.map((line) => line.rows)]).toEqual([
      {},
      [20, 20, 20, 20],
      [2500],
    ]);
  });

  it("ends between two batches when its signal aborts", async () => {
    const stop = new AbortController();
    let batches = 0;
    const abortAfterFirstBatch: RetentionPolicy["run"] = async (context) => {
      batches += 1;
      const deleted = await deleteEvents(context);
      stop.abort(new Error("stop"));
      return deleted;
    };
    const { test, parts, retention } = await setup({
      features: [emptyFeature("debugger", { retention: [eventsPolicy({ run: abortAfterFirstBatch })] })],
    });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(40), count: 2500 });

    await scheduleRetention(firstPolicy(retention), parts).run(stop.signal);

    expect([batches, await countEvents(test.db)]).toEqual([1, { [ORG_A]: 1500 }]);
  });

  it("rolls back the batch of an organization that fails, still runs the others and fails the run", async () => {
    const failInOrgA: RetentionPolicy["run"] = async (context) => {
      const deleted = await deleteEvents(context);
      if (context.orgId === ORG_A) {
        throw new Error("a broke");
      }
      return deleted;
    };
    const { test, parts, retention } = await setup({
      features: [emptyFeature("debugger", { retention: [eventsPolicy({ run: failInOrgA })] })],
    });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(40), count: 2 });
    await addEvents(test.db, { orgId: ORG_B, at: daysAgo(40), count: 2 });

    await expect(scheduleRetention(firstPolicy(retention), parts).run(neverAborted)).rejects.toThrow(OrgRunError);

    const failed = test.log.lines().filter((line) => line.msg === "A job failed in an organization");
    expect([await countEvents(test.db), failed.map((line) => line.orgId)]).toEqual([{ [ORG_A]: 2 }, [ORG_A]]);
  });

  it("skips organizations without the entitlement of an extension's feature", async () => {
    const { test, parts, retention } = await setup({
      extension: fixtureExtension(paidFeature("paid", { retention: [eventsPolicy()] })),
    });
    await addEvents(test.db, { orgId: ORG_A, at: daysAgo(40), count: 2 });

    await scheduleRetention(firstPolicy(retention), parts).run(neverAborted);

    expect(await countEvents(test.db)).toEqual({ [ORG_A]: 2 });
  });
});

describe("warnUnusedRetentionDays", () => {
  it("warns of a setting that no policy reads, naming it as the operator wrote it", async () => {
    const { test, retention } = await setup({
      features: [emptyFeature("debugger", { retention: [eventsPolicy()] })],
    });

    warnUnusedRetentionDays(retention, { events: 7, snapshots: 3 }, test.logger);

    const warnings = test.log.lines().filter((line) => line.setting !== undefined);
    expect(warnings.map((line) => [line.level, line.setting])).toEqual([[40, "MICAFOX_RETENTION_SNAPSHOTS_DAYS"]]);
  });
});
