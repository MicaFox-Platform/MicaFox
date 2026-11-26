import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openJobsDatabase } from "../../../../../test/db/jobs-database.js";
import { ORG_A, ORG_B } from "../../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../../test/db/test-database.js";
import { createTestEvents } from "../../../../../test/events/test-events.js";
import {
  addEnvironment,
  addOfflineInstances,
  readInstances,
} from "../../../../../test/sdk-endpoint/instances-database.js";
import { helloOf } from "../../../../../test/sdk-endpoint/sdk-client.js";
import type { KeyScope } from "../../../access/index.js";
import type { Database } from "../../../db/index.js";
import type { HubEvent } from "../../../events/index.js";
import { createInstances } from "../index.js";
import type { Instances } from "../index.js";
import { MAX_INSTANCES_PER_ENVIRONMENT } from "../queries.js";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const DAY_MS = 24 * 60 * 60_000;

let test: TestDatabase;
let key: KeyScope;
let now: number;
let events: HubEvent[];
let warnings: string[];
let instances: Instances;

const instancesOf = (db: Database): Instances =>
  createInstances({
    db,
    bus: (() => {
      const { bus } = createTestEvents();
      bus.subscribe((event) => events.push(event));
      return bus;
    })(),
    now: () => now,
    warnCollapsed: (_key, _fields, message) => {
      warnings.push(message);
    },
  });

// A session that closes when `close` is called
const session = (hello = helloOf(), modules: readonly string[] = ["debugger"]) => {
  let close = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return { key, hello, modules, closed, close };
};

// Closes a session and waits until the instances have written what its close leaves
const closeAndSettle = async (one: ReturnType<typeof session>): Promise<void> => {
  one.close();
  await one.closed;
  await instances.idle();
};

beforeEach(async () => {
  now = NOW;
  events = [];
  warnings = [];
  test = await openJobsDatabase();
  key = await addEnvironment(test.db, ORG_A);
  instances = instancesOf(test.db);
});

afterEach(async () => {
  await test.close();
});

describe("track", () => {
  it("upserts the instance with the fields of its hello and says it connected", async () => {
    const hello = helloOf({ instanceId: "instance-1", labels: { region: "eu" }, service: "checkout" });

    await instances.track(session(hello));

    expect(await readInstances(test.db, key.environmentId)).toEqual([
      {
        instanceId: "instance-1",
        service: "checkout",
        hostname: "checkout-7d9f",
        labels: { region: "eu" },
        modules: ["debugger"],
        keyPrefix: key.prefix,
        connectedAt: new Date(NOW).toISOString(),
        lastSeenAt: new Date(NOW).toISOString(),
      },
    ]);
    expect(events).toEqual([
      {
        type: "instance.connected",
        orgId: ORG_A,
        environmentId: key.environmentId,
        actor: { userId: "system" },
        data: { environmentId: key.environmentId, instanceId: "instance-1" },
      },
    ]);
  });

  it("keeps one row for an instance that connects again, with the fields and the time of the last hello", async () => {
    await instances.track(session(helloOf({ instanceId: "instance-1", hostname: "old" })));
    now += 1000;

    await instances.track(session(helloOf({ instanceId: "instance-1", hostname: "new", service: undefined })));

    const rows = await readInstances(test.db, key.environmentId);
    expect(rows.map((row) => [row.hostname, row.service, row.connectedAt])).toEqual([
      ["new", null, new Date(NOW + 1000).toISOString()],
    ]);
  });

  it("never lets an older hello written late overwrite a newer one", async () => {
    now = NOW + 1000;
    await instances.track(session(helloOf({ instanceId: "instance-1", hostname: "newer" })));
    now = NOW;

    await instances.track(session(helloOf({ instanceId: "instance-1", hostname: "older" })));

    const rows = await readInstances(test.db, key.environmentId);
    expect(rows.map((row) => [row.hostname, row.connectedAt])).toEqual([["newer", new Date(NOW + 1000).toISOString()]]);
  });

  it("keeps instances of one environment apart from those of another with the same instanceId", async () => {
    const other = await addEnvironment(test.db, ORG_B);

    await instances.track(session(helloOf({ instanceId: "same" })));
    await instances.track({ ...session(helloOf({ instanceId: "same" })), key: other });

    expect([
      (await readInstances(test.db, key.environmentId)).length,
      (await readInstances(test.db, other.environmentId)).length,
    ]).toEqual([1, 1]);
  });

  it("cuts overlong fields, stores what fits and answers how many it cut", async () => {
    const hello = helloOf({ service: "s".repeat(500), labels: { "k\u0000": "v".repeat(500) } });

    const tracked = await instances.track(session(hello));

    const [row] = await readInstances(test.db, key.environmentId);
    expect([row?.service?.length, row?.labels, tracked]).toEqual([
      128,
      { "k�": "v".repeat(256) },
      { cut: 2, replaced: 1 },
    ]);
  });

  it("logs a failed write and leaves the session without a row, with no event", async () => {
    const failing = { ...test.db, forOrg: async () => await Promise.reject(new Error("connection refused")) };
    const broken = instancesOf(failing);
    const one = session();

    const tracked = await broken.track(one);
    one.close();
    await one.closed;
    await broken.idle();

    expect([tracked, warnings, events, await readInstances(test.db, key.environmentId)]).toEqual([
      { cut: 0, replaced: 0 },
      // The close writes the last seen time of a row an earlier connection may have left, which fails as well
      ["instances.upsert-failed", "instances.last-seen-failed"],
      [],
      [],
    ]);
  });
});

describe("going offline", () => {
  it("writes the last seen time and says it disconnected when the session closes", async () => {
    const one = session(helloOf({ instanceId: "instance-1" }));
    await instances.track(one);
    events.length = 0;
    now += 90_000;

    await closeAndSettle(one);

    const [row] = await readInstances(test.db, key.environmentId);
    expect(row?.lastSeenAt).toBe(new Date(NOW + 90_000).toISOString());
    expect(events.map((event) => [event.type, event.data])).toEqual([
      ["instance.disconnected", { environmentId: key.environmentId, instanceId: "instance-1" }],
    ]);
  });

  it("neither writes nor announces anything for a session that a newer one of the instance replaced", async () => {
    const first = session(helloOf({ instanceId: "instance-1" }));
    const second = session(helloOf({ instanceId: "instance-1" }));
    await instances.track(first);
    await instances.track(second);
    events.length = 0;
    now += 60_000;

    await closeAndSettle(first);

    expect([events, (await readInstances(test.db, key.environmentId))[0]?.lastSeenAt]).toEqual([
      [],
      new Date(NOW).toISOString(),
    ]);

    await closeAndSettle(second);

    expect(events.map((event) => event.type)).toEqual(["instance.disconnected"]);
  });

  it("logs a failed last-seen write and still says it disconnected", async () => {
    const one = session();
    await instances.track(one);
    events.length = 0;
    await test.close();

    await closeAndSettle(one);

    expect([warnings, events.map((event) => event.type)]).toEqual([
      ["instances.last-seen-failed"],
      ["instance.disconnected"],
    ]);
    test = await openJobsDatabase();
  });
});

describe("writeLastSeen", () => {
  it("writes the last seen time of the instances this replica holds a session for, and of no other", async () => {
    await addOfflineInstances(test.db, key, { count: 1, firstSeenAt: new Date(NOW - DAY_MS), prefix: "gone" });
    await instances.track(session(helloOf({ instanceId: "here" })));
    now += 60_000;

    await instances.writeLastSeen();

    const seen = Object.fromEntries(
      (await readInstances(test.db, key.environmentId)).map((row) => [row.instanceId, row.lastSeenAt]),
    );
    expect(seen).toEqual({
      "gone-0000": new Date(NOW - DAY_MS).toISOString(),
      here: new Date(NOW + 60_000).toISOString(),
    });
  });

  it("rejects when the write fails, so the job counts the run as failed", async () => {
    const failing = { ...test.db, system: async () => await Promise.reject(new Error("connection refused")) };
    const broken = instancesOf(failing);
    await broken.track(session());

    await expect(broken.writeLastSeen()).rejects.toThrow("connection refused");
    await expect(broken.deleteStale()).rejects.toThrow("connection refused");
  });

  it("writes nothing while no instance is online", async () => {
    await instances.writeLastSeen();

    expect(await readInstances(test.db, key.environmentId)).toEqual([]);
  });

  it("writes nothing for an instance whose session closed", async () => {
    const one = session(helloOf({ instanceId: "instance-1" }));
    await instances.track(one);
    await closeAndSettle(one);
    now += 60_000;

    await instances.writeLastSeen();

    const [row] = await readInstances(test.db, key.environmentId);
    expect(row?.lastSeenAt).toBe(new Date(NOW).toISOString());
  });
});

describe("the cap of an environment", () => {
  it("deletes the oldest offline instance when a new one goes beyond 1000", async () => {
    await addOfflineInstances(test.db, key, {
      count: MAX_INSTANCES_PER_ENVIRONMENT,
      firstSeenAt: new Date(NOW - DAY_MS),
    });

    await instances.track(session(helloOf({ instanceId: "new" })));

    const ids = (await readInstances(test.db, key.environmentId)).map((row) => row.instanceId);
    expect([ids.length, ids.includes("i-0000"), ids.includes("i-0001"), ids.includes("new")]).toEqual([
      1000,
      false,
      true,
      true,
    ]);
  });

  it("never deletes an instance that is online, even the oldest", async () => {
    await addOfflineInstances(test.db, key, {
      count: MAX_INSTANCES_PER_ENVIRONMENT,
      firstSeenAt: new Date(NOW - DAY_MS),
    });
    now = NOW - 2 * DAY_MS;
    await instances.track(session(helloOf({ instanceId: "i-0000" })));
    now = NOW;

    await instances.track(session(helloOf({ instanceId: "new" })));

    const ids = (await readInstances(test.db, key.environmentId)).map((row) => row.instanceId);
    expect([ids.length, ids.includes("i-0000"), ids.includes("i-0001")]).toEqual([1000, true, false]);
  });

  it("deletes nothing when an instance that is already there connects again", async () => {
    await addOfflineInstances(test.db, key, {
      count: MAX_INSTANCES_PER_ENVIRONMENT,
      firstSeenAt: new Date(NOW - DAY_MS),
    });

    await instances.track(session(helloOf({ instanceId: "i-0500" })));

    expect(await readInstances(test.db, key.environmentId)).toHaveLength(MAX_INSTANCES_PER_ENVIRONMENT);
  });

  it("counts the instances of each environment apart", async () => {
    const other = await addEnvironment(test.db, ORG_B);
    await addOfflineInstances(test.db, other, {
      count: MAX_INSTANCES_PER_ENVIRONMENT,
      firstSeenAt: new Date(NOW - DAY_MS),
    });

    await instances.track(session(helloOf({ instanceId: "new" })));

    expect([
      (await readInstances(test.db, key.environmentId)).length,
      (await readInstances(test.db, other.environmentId)).length,
    ]).toEqual([1, 1000]);
  });
});

describe("deleteStale", () => {
  it("deletes the instances not seen for 7 days, in every organization, and keeps the others", async () => {
    const other = await addEnvironment(test.db, ORG_B);
    await addOfflineInstances(test.db, key, { count: 1, firstSeenAt: new Date(NOW - 8 * DAY_MS), prefix: "old" });
    await addOfflineInstances(test.db, key, { count: 1, firstSeenAt: new Date(NOW - 6 * DAY_MS), prefix: "recent" });
    await addOfflineInstances(test.db, other, { count: 1, firstSeenAt: new Date(NOW - 9 * DAY_MS), prefix: "old-b" });

    await instances.deleteStale();

    expect([
      (await readInstances(test.db, key.environmentId)).map((row) => row.instanceId),
      await readInstances(test.db, other.environmentId),
    ]).toEqual([["recent-0000"], []]);
  });
});
