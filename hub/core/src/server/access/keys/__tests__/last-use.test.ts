import type { KyselyPlugin } from "kysely";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { addProjectKey, readLastUse } from "../../../../../test/access/project-key.js";
import { openJobsDatabase } from "../../../../../test/db/jobs-database.js";
import { ORG_A } from "../../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../../test/db/test-database.js";
import type { Database } from "../../../db/index.js";
import { createKeyUses } from "../index.js";
import type { KeyUses } from "../index.js";

const T0 = Date.parse("2026-11-25T12:00:00Z");

const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

const open = async (): Promise<TestDatabase> => {
  const test = await openJobsDatabase();
  opened.push(test);
  return test;
};

// Fails every query before it reaches the database, as while Postgres is down; the app role may not alter tables
const failEveryQuery: KyselyPlugin = {
  transformQuery: () => {
    throw new Error("connection refused");
  },
  transformResult: async (args) => await Promise.resolve(args.result),
};

// The test database, down until `isDown` is set to false
const flakyDatabase = (db: Database, state: { isDown: boolean }): Database => {
  const down = db.global.withPlugin(failEveryQuery);
  return {
    ...db,
    get global() {
      return state.isDown ? down : db.global;
    },
  };
};

// Notes `count` keys no row has, as the uses of many keys within a minute
const noteOthers = (uses: KeyUses, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    uses.note(randomUUID());
  }
};

describe("createKeyUses", () => {
  it("writes the last time each noted key was used", async () => {
    const test = await open();
    const first = await addProjectKey(test.db, { orgId: ORG_A });
    const second = await addProjectKey(test.db, { orgId: ORG_A });
    let now = T0;
    const uses = createKeyUses({ db: test.db, now: () => now });
    uses.note(first);
    now = T0 + 1000;
    uses.note(second);
    now = T0 + 2000;
    uses.note(first);

    await uses.write();

    expect([await readLastUse(test.db, first), await readLastUse(test.db, second)]).toEqual([
      new Date(T0 + 2000).toISOString(),
      new Date(T0 + 1000).toISOString(),
    ]);
  });

  it("never moves a key's last use back", async () => {
    const test = await open();
    const later = new Date(T0 + 60_000).toISOString();
    const keyId = await addProjectKey(test.db, { orgId: ORG_A, lastUsedAt: later });
    const uses = createKeyUses({ db: test.db, now: () => T0 });
    uses.note(keyId);

    await uses.write();

    expect(await readLastUse(test.db, keyId)).toBe(later);
  });

  it("keeps the uses of a failed write for the next one", async () => {
    const test = await open();
    const keyId = await addProjectKey(test.db, { orgId: ORG_A });
    const state = { isDown: true };
    const uses = createKeyUses({ db: flakyDatabase(test.db, state), now: () => T0 });
    uses.note(keyId);
    await expect(uses.write()).rejects.toThrow("connection refused");
    state.isDown = false;

    await uses.write();

    expect(await readLastUse(test.db, keyId)).toBe(new Date(T0).toISOString());
  });

  it("drops the use of a new key past 10,000 noted keys", async () => {
    const test = await open();
    const keyId = await addProjectKey(test.db, { orgId: ORG_A });
    const uses = createKeyUses({ db: test.db, now: () => T0 });
    noteOthers(uses, 10_000);
    uses.note(keyId);

    await uses.write();

    expect(await readLastUse(test.db, keyId)).toBeNull();
  });

  it("still updates a key noted before the limit was reached", async () => {
    const test = await open();
    const keyId = await addProjectKey(test.db, { orgId: ORG_A });
    let now = T0;
    const uses = createKeyUses({ db: test.db, now: () => now });
    uses.note(keyId);
    noteOthers(uses, 9999);
    now = T0 + 1000;
    uses.note(keyId);

    await uses.write();

    expect(await readLastUse(test.db, keyId)).toBe(new Date(T0 + 1000).toISOString());
  });
});
