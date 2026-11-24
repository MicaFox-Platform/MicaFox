import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { ORG_A } from "../../../../test/db/test-database.js";
import { emptyFeature } from "../../../../test/feature/fixtures.js";
import { envOf, TEST_MODE_LINES } from "../../../../test/server/env.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import type { Feature } from "../../feature/index.js";
import { createHub } from "../index.js";
import type { Clock, Hub } from "../index.js";

const hubs: Hub[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map(async (hub) => await hub.stop()));
});

// A hub in test mode with one organization, added before the hub is ready, so the jobs find it when they start
const createWithOrganization = (features: readonly Feature[], clock?: Clock): Hub => {
  const hub = createHub({
    env: envOf(TEST_MODE_LINES),
    version: "1.2.3",
    build: "basic-hub",
    features,
    logStream: captureLog().stream,
    ...(clock === undefined ? {} : { clock }),
  });
  hubs.push(hub);
  hub.addReadinessStep("organization", async () => {
    await hub.db.system("test: add the organization", async (trx) => {
      await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme')`.execute(trx);
    });
  });
  return hub;
};

interface ManualClock {
  clock: Clock;
  /** Settles once a timer of `delayMs` is pending. */
  pending: (delayMs: number) => Promise<void>;
  /** Fires the pending timers of `delayMs`. */
  fire: (delayMs: number) => void;
  /** Whether a timer of `delayMs` is pending now. */
  isPending: (delayMs: number) => boolean;
}

// Timers that fire only when the test says, picked by their delay; time stands still
const createManualClock = (): ManualClock => {
  const timers = new Map<NodeJS.Timeout, { callback: () => void; delayMs: number }>();
  const waiters: Array<{ delayMs: number; resolve: () => void }> = [];
  return {
    clock: {
      now: () => 0,
      setTimeout: (callback, delayMs) => {
        // A real handle that never fires, as the key a clearTimeout passes back
        const handle = setTimeout(() => undefined, 0);
        clearTimeout(handle);
        timers.set(handle, { callback, delayMs });
        for (const waiter of waiters.filter((candidate) => candidate.delayMs === delayMs)) {
          waiter.resolve();
        }
        return handle;
      },
      clearTimeout: (handle) => {
        timers.delete(handle);
      },
    },
    pending: async (delayMs) => {
      await new Promise<void>((resolve) => {
        if ([...timers.values()].some((timer) => timer.delayMs === delayMs)) {
          resolve();
          return;
        }
        waiters.push({ delayMs, resolve });
      });
    },
    isPending: (delayMs) => [...timers.values()].some((timer) => timer.delayMs === delayMs),
    fire: (delayMs) => {
      for (const [handle, timer] of [...timers]) {
        if (timer.delayMs === delayMs) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
  };
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("createHub jobs", () => {
  it("runs a feature's job for each organization once the hub is ready, not before", async () => {
    const ran = deferred();
    const seen: string[] = [];
    const hub = createWithOrganization([
      emptyFeature("debugger", {
        jobs: [
          {
            name: "expire",
            everyMs: 60_000,
            run: async ({ orgId }) => {
              seen.push(orgId);
              ran.resolve();
              await Promise.resolve();
            },
          },
        ],
      }),
    ]);
    const released = deferred();
    hub.addReadinessStep("held", async () => {
      await released.promise;
    });

    const running = await hub.start();
    const beforeReady = [...seen];
    released.resolve();
    await running.ready;
    await ran.promise;

    expect([beforeReady, seen]).toEqual([[], [ORG_A]]);
  });

  it("aborts a running job on stop and waits for it before the database closes", async () => {
    const started = deferred();
    const events: string[] = [];
    const hub = createWithOrganization([
      emptyFeature("debugger", {
        jobs: [
          {
            name: "hang",
            everyMs: 60_000,
            run: async ({ signal, forOrg }) => {
              started.resolve();
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => {
                  resolve();
                });
              });
              // The database is still open: the stop waits for running jobs before it closes it
              await forOrg(async (trx) => {
                await sql`select 1`.execute(trx);
              });
              events.push("job finished");
            },
          },
        ],
      }),
    ]);
    const running = await hub.start();
    await running.ready;
    await started.promise;

    const result = await hub.stop();

    expect([result.clean, events]).toEqual([true, ["job finished"]]);
  });

  it("drops the next tick of every job as soon as the stop begins, before the requests drain", async () => {
    // Over the 10-minute run limit, so the only timer of this delay is the next tick, not the run's limit
    const EVERY_MS = 3_600_000;
    const manual = createManualClock();
    const ran = deferred();
    const hub = createWithOrganization(
      [
        emptyFeature("debugger", {
          jobs: [
            {
              name: "count",
              everyMs: EVERY_MS,
              run: async () => {
                ran.resolve();
                await Promise.resolve();
              },
            },
          ],
        }),
      ],
      manual.clock,
    );
    const seenWhileDraining: boolean[] = [];
    // Added after the jobs' own hooks, so it sees what they left before the drain
    hub.addStopHook(
      "probe",
      async () => {
        seenWhileDraining.push(manual.isPending(EVERY_MS));
        await Promise.resolve();
      },
      { phase: "before-drain" },
    );
    const running = await hub.start();
    await running.ready;
    manual.fire(0);
    await ran.promise;
    await manual.pending(EVERY_MS);

    await hub.stop();

    expect(seenWhileDraining).toEqual([false]);
  });
});
