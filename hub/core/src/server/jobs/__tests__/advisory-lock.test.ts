import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { isOnPostgres, openTestDatabase } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { createPostgresLocks, PGLITE_LOCKS } from "../advisory-lock.js";

const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

const openLocks = async (): Promise<{ test: TestDatabase; locks: ReturnType<typeof createPostgresLocks> }> => {
  const test = await openTestDatabase();
  opened.push(test);
  return { test, locks: createPostgresLocks(test.url, test.logger) };
};

describe("createPostgresLocks", () => {
  // PGlite has one connection, so a lock can only be proved on Postgres (database.md#running-on-pglite)
  it.runIf(isOnPostgres)("refuses a job's lock while another holds it and gives it again once released", async () => {
    const { locks } = await openLocks();

    const first = await locks.tryLock("expire");
    const whileHeld = await locks.tryLock("expire");
    await first?.release();
    const afterRelease = await locks.tryLock("expire");
    await afterRelease?.release();

    expect([first !== undefined, whileHeld, afterRelease !== undefined]).toEqual([true, undefined, true]);
  });

  it.runIf(isOnPostgres)("locks each job on its own, so two jobs run side by side", async () => {
    const { locks } = await openLocks();

    const expire = await locks.tryLock("expire");
    const cleanup = await locks.tryLock("cleanup");
    await expire?.release();
    await cleanup?.release();

    expect([expire !== undefined, cleanup !== undefined]).toEqual([true, true]);
  });

  it.runIf(isOnPostgres)("takes a connection of its own, which the pool does not lend to anyone else", async () => {
    const { test, locks } = await openLocks();
    const held = await locks.tryLock("expire");

    const { rows } = await test.db.system("test: list the advisory locks", async (trx) => {
      return await sql<{
        count: number;
      }>`select count(*)::int as count from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())`.execute(
        trx,
      );
    });
    await held?.release();

    expect(rows[0]?.count).toBe(1);
  });

  it.runIf(isOnPostgres)("aborts `lost` when its connection is closed by the server", async () => {
    const { test, locks } = await openLocks();
    const held = await locks.tryLock("expire");
    const lost = new Promise<unknown>((resolve) => {
      held?.lost.addEventListener("abort", () => {
        resolve(held.lost.reason);
      });
    });

    await test.db.system("test: close the lock's connection", async (trx) => {
      await sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())`.execute(
        trx,
      );
    });

    await expect(lost).resolves.toBeInstanceOf(Error);
  });

  it.runIf(isOnPostgres)("fails when the database cannot be reached", async () => {
    const { test } = await openLocks();
    const unreachable = createPostgresLocks(test.url.replace(/@[^/]+\//, "@127.0.0.1:1/"), test.logger);

    await expect(unreachable.tryLock("expire")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("PGLITE_LOCKS", () => {
  it("always grants the lock: PGlite has one session and no other replica", async () => {
    const held = await PGLITE_LOCKS.tryLock("expire");

    expect(held?.lost.aborted).toBe(false);
  });
});
