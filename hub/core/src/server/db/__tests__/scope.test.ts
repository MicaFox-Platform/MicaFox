import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  addNote,
  bodiesSeenBy,
  createNotes,
  isOnPostgres,
  notesOf,
  openTestDatabase,
  ORG_A,
  ORG_B,
} from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { NestedScopeError } from "../index.js";

const opened: TestDatabase[] = [];

// A database with notes of two organizations, on PGlite or the Postgres of MICAFOX_TEST_DATABASE_URL
const withNotesOfTwoOrgs = async (options: { poolSize?: number } = {}): Promise<TestDatabase> => {
  const test = await openTestDatabase(options);
  opened.push(test);
  await createNotes(test.db);
  await addNote(test.db, ORG_A, "a1");
  await addNote(test.db, ORG_B, "b1");
  return test;
};

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

interface Countdown {
  done: Promise<void>;
  tick: () => void;
}

// Settles once `count` callers are inside their transactions at the same time
const createCountdown = (count: number): Countdown => {
  let left = count;
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    done,
    tick: () => {
      left -= 1;
      if (left === 0) {
        finish();
      }
    },
  };
};

describe("db.forOrg", () => {
  it("sees only the rows of its organization", async () => {
    const { db } = await withNotesOfTwoOrgs();

    const seen = await notesOf(db, ORG_A);

    expect(seen).toEqual(["a1"]);
  });

  it("refuses to write a row of another organization", async () => {
    const { db } = await withNotesOfTwoOrgs();

    const writing = db.forOrg(ORG_A, async (trx) => {
      await sql`insert into notes (org_id, body) values (${ORG_B}, 'planted')`.execute(trx);
    });

    await expect(writing).rejects.toThrow(/row-level security/);
    await expect(notesOf(db, ORG_B)).resolves.toEqual(["b1"]);
  });

  it("rejects an organization id that is not a UUID, without querying", async () => {
    const { db } = await withNotesOfTwoOrgs();

    await expect(
      db.forOrg("' or true --", async () => {
        await Promise.resolve();
      }),
    ).rejects.toThrow(RangeError);
  });

  it("leaves no organization set on the reused connection of a pool of one", async () => {
    const { db } = await withNotesOfTwoOrgs({ poolSize: 1 });
    await notesOf(db, ORG_A);

    const seenByB = await notesOf(db, ORG_B);
    const seenOutside = await bodiesSeenBy(db.global);

    expect(seenByB).toEqual(["b1"]);
    expect(seenOutside).toEqual([]);
  });

  it("rolls back what it wrote when its callback throws", async () => {
    const { db } = await withNotesOfTwoOrgs();

    const failing = db.forOrg(ORG_A, async (trx) => {
      await sql`insert into notes (org_id, body) values (${ORG_A}, 'a2')`.execute(trx);
      throw new Error("the request failed");
    });

    await expect(failing).rejects.toThrow("the request failed");
    await expect(notesOf(db, ORG_A)).resolves.toEqual(["a1"]);
  });
});

describe("db.global", () => {
  it("sees no row of an organization's table, instead of failing on the empty setting", async () => {
    const { db } = await withNotesOfTwoOrgs();

    const seen = await bodiesSeenBy(db.global);

    expect(seen).toEqual([]);
  });

  it("sees no organization's rows while a scoped transaction with its organization set is open", async () => {
    const { db } = await withNotesOfTwoOrgs();
    const inside = createCountdown(1);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scoped = db.forOrg(ORG_A, async (trx) => {
      await bodiesSeenBy(trx);
      inside.tick();
      await held;
    });
    await inside.done;

    const outside = bodiesSeenBy(db.global);
    await new Promise((resolve) => setImmediate(resolve));
    release();

    await expect(outside).resolves.toEqual([]);
    await scoped;
  });
});

describe("db.system", () => {
  it("sees every organization's rows and logs its reason", async () => {
    const { db, log } = await withNotesOfTwoOrgs();

    const seen = await db.system("retention", async (trx) => await bodiesSeenBy(trx));

    expect(seen).toEqual(["a1", "b1"]);
    expect(log.lines()).toContainEqual(expect.objectContaining({ level: 30, msg: "db.system", reason: "retention" }));
  });

  it("logs its reason at debug when asked, for work that repeats often", async () => {
    const { db, log } = await withNotesOfTwoOrgs();

    await db.system("retention", async (trx) => await bodiesSeenBy(trx), { logLevel: "debug" });

    expect(log.lines()).toContainEqual(expect.objectContaining({ level: 20, msg: "db.system", reason: "retention" }));
  });
});

describe("a call to db inside a scoped callback", () => {
  it("fails at once for db.global, instead of waiting for the connection its own transaction holds", async () => {
    const { db } = await withNotesOfTwoOrgs({ poolSize: 1 });

    const nested = db.forOrg(ORG_A, async () => await bodiesSeenBy(db.global));

    await expect(nested).rejects.toThrow(NestedScopeError);
  });

  it("fails at once for another scope", async () => {
    const { db } = await withNotesOfTwoOrgs({ poolSize: 1 });

    const nested = db.system("retention", async () => await notesOf(db, ORG_A));

    await expect(nested).rejects.toThrow(NestedScopeError);
  });

  it("is allowed again from work the callback left running after it ended", async () => {
    const { db } = await withNotesOfTwoOrgs();
    let later: Promise<string[]> | undefined;

    await db.forOrg(ORG_A, async () => {
      later = Promise.resolve().then(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return await notesOf(db, ORG_B);
      });
      await Promise.resolve();
    });

    await expect(later).resolves.toEqual(["b1"]);
  });
});

// PGlite has one connection: these need several, so they run only on Postgres, in CI
describe.runIf(isOnPostgres)("db.forOrg on several connections", () => {
  it("keeps two organizations apart while their transactions run at the same time", async () => {
    const { db } = await withNotesOfTwoOrgs({ poolSize: 2 });
    const bothInside = createCountdown(2);
    const readTogether = async (orgId: string): Promise<string[]> =>
      await db.forOrg(orgId, async (trx) => {
        bothInside.tick();
        await bothInside.done;
        return await bodiesSeenBy(trx);
      });

    const seen = await Promise.all([readTogether(ORG_A), readTogether(ORG_B)]);

    expect(seen).toEqual([["a1"], ["b1"]]);
  });

  it("opens no more connections than MICAFOX_DATABASE_POOL_SIZE", async () => {
    const { db } = await withNotesOfTwoOrgs({ poolSize: 2 });
    const twoInside = createCountdown(2);
    const countConnections = async (orgId: string): Promise<string> =>
      await db.forOrg(orgId, async (trx) => {
        twoInside.tick();
        await twoInside.done;
        const { rows } = await sql<{ connections: string }>`
          select count(*) as connections from pg_stat_activity
          where datname = current_database() and usename = current_user
        `.execute(trx);
        return rows[0]?.connections ?? "none";
      });

    const counts = await Promise.all([countConnections(ORG_A), countConnections(ORG_B), countConnections(ORG_A)]);

    expect(counts).toEqual(["2", "2", "2"]);
  });
});
