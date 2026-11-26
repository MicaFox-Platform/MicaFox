import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { createEvents, openJobsDatabase } from "../../../../test/db/jobs-database.js";
import { ORG_A, ORG_B } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { emptyFeature, fixtureExtension, paidFeature } from "../../../../test/feature/fixtures.js";
import { createEntitlements } from "../../access/index.js";
import { createFeatureRegistry, createGate } from "../../feature/index.js";
import type { Extension, FeatureJob, SdkApi } from "../../feature/index.js";
import { scheduleFeatureJob } from "../feature-jobs.js";
import { OrgRunError } from "../for-each-org.js";

const neverAborted = new AbortController().signal;
const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

const sdk: SdkApi = {
  resend: async () => {
    await Promise.resolve();
  },
};

const setup = async (job: FeatureJob, extension?: Extension, given: SdkApi = sdk) => {
  const test = await openJobsDatabase();
  opened.push(test);
  await createEvents(test.db);
  const registry = createFeatureRegistry(
    extension === undefined ? [emptyFeature("debugger", { jobs: [job] })] : [],
    extension,
  );
  const gate = createGate(registry, createEntitlements({ sources: [], now: () => Date.now() }));
  const [registered] = registry.jobs;
  if (registered === undefined) {
    throw new Error("The fixture has no job");
  }
  return { test, scheduled: scheduleFeatureJob(registered, { db: test.db, gate, log: test.logger, sdk: given }) };
};

describe("scheduleFeatureJob", () => {
  it("keeps the job's name and interval", async () => {
    const { scheduled } = await setup({
      name: "expire",
      everyMs: 60_000,
      run: async () => {
        await Promise.resolve();
      },
    });

    expect([scheduled.name, scheduled.everyMs]).toEqual(["expire", 60_000]);
  });

  it("runs the job once for each organization", async () => {
    const seen: string[] = [];
    const { scheduled } = await setup({
      name: "expire",
      everyMs: 60_000,
      run: async ({ orgId }) => {
        seen.push(orgId);
        await Promise.resolve();
      },
    });

    await scheduled.run(neverAborted);

    expect(seen.sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it("gives the job a transaction that sees only its organization", async () => {
    const counts: Record<string, number> = {};
    const { test, scheduled } = await setup({
      name: "count",
      everyMs: 60_000,
      run: async ({ orgId, forOrg }) => {
        counts[orgId] = await forOrg(async (trx) => {
          const { rows } = await sql<{ count: number }>`select count(*)::int as count from events`.execute(trx);
          return rows[0]?.count ?? -1;
        });
      },
    });
    await test.db.forOrg(ORG_A, async (trx) => {
      await sql`insert into events (org_id, created_at) values (${ORG_A}, now()), (${ORG_A}, now())`.execute(trx);
    });
    await test.db.forOrg(ORG_B, async (trx) => {
      await sql`insert into events (org_id, created_at) values (${ORG_B}, now())`.execute(trx);
    });

    await scheduled.run(neverAborted);

    expect(counts).toEqual({ [ORG_A]: 2, [ORG_B]: 1 });
  });

  it("gives the job the hub's sdk to resend a module's state", async () => {
    const resent: Array<[string, string]> = [];
    const { scheduled } = await setup(
      {
        name: "expire",
        everyMs: 60_000,
        run: async ({ sdk: given }) => {
          await given.resend("production", "debugger");
        },
      },
      undefined,
      {
        resend: async (environmentId, module) => {
          resent.push([environmentId, module]);
          await Promise.resolve();
        },
      },
    );

    await scheduled.run(neverAborted);

    expect(resent).toEqual([
      ["production", "debugger"],
      ["production", "debugger"],
    ]);
  });

  it("logs with the job and the organization bound", async () => {
    const { test, scheduled } = await setup({
      name: "expire",
      everyMs: 60_000,
      run: async ({ log }) => {
        log.info("expired");
        await Promise.resolve();
      },
    });

    await scheduled.run(neverAborted);

    expect(
      test.log
        .lines()
        .filter((line) => line.msg === "expired")
        .map((line) => [line.job, line.orgId])
        .sort(),
    ).toEqual(
      [
        ["expire", ORG_A],
        ["expire", ORG_B],
      ].sort(),
    );
  });

  it("runs the next organization after one fails, then fails the run, naming the organization in the log", async () => {
    const seen: string[] = [];
    const { test, scheduled } = await setup({
      name: "expire",
      everyMs: 60_000,
      run: async ({ orgId }) => {
        seen.push(orgId);
        if (orgId === ORG_A) {
          await Promise.reject(new Error("a broke"));
        }
      },
    });

    await expect(scheduled.run(neverAborted)).rejects.toThrow(OrgRunError);

    expect([
      seen.length,
      test.log
        .lines()
        .filter((line) => line.msg === "A job failed in an organization")
        .map((line) => line.orgId),
    ]).toEqual([2, [ORG_A]]);
  });

  it("starts no organization once its signal aborts", async () => {
    const stop = new AbortController();
    const seen: string[] = [];
    const { scheduled } = await setup({
      name: "expire",
      everyMs: 60_000,
      run: async ({ orgId }) => {
        seen.push(orgId);
        stop.abort(new Error("stop"));
        await Promise.resolve();
      },
    });

    await scheduled.run(stop.signal);

    expect(seen).toHaveLength(1);
  });

  it("skips organizations without the entitlement of an extension's feature", async () => {
    const seen: string[] = [];
    const { scheduled } = await setup(
      {
        name: "expire",
        everyMs: 60_000,
        run: async () => {
          await Promise.resolve();
        },
      },
      fixtureExtension(
        paidFeature("paid", {
          jobs: [
            {
              name: "paid-expire",
              everyMs: 60_000,
              run: async ({ orgId }) => {
                seen.push(orgId);
                await Promise.resolve();
              },
            },
          ],
        }),
      ),
    );

    await scheduled.run(neverAborted);

    expect(seen).toEqual([]);
  });
});
