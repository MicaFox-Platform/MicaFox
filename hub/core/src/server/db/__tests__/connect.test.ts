import { sql } from "kysely";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isOnPostgres, openTestDatabase } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import type { Timers } from "../../observability/index.js";
import { connectDatabase, DatabaseRoleError, isUnreachable, ProbeTimeoutError, retryDelayMs } from "../connect.js";
import type { RoleProbe } from "../connect.js";
import { connect, createDatabase } from "../index.js";
import type { Database } from "../index.js";

const APP: RoleProbe = { role: "micafox_app", isSuperuser: false, bypassesRls: false };

const systemError = (code: string): Error => Object.assign(new Error(`connect ${code}`), { code, syscall: "connect" });
const postgresError = (code: string): Error =>
  Object.assign(new Error(`postgres ${code}`), { code, severity: "FATAL" });

// Vitest fakes the global timers; the step gets them as the hub gives it its clock
const timers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

// A probe that answers with the given outcomes in order, then with the app role
const probeAnswering = (...outcomes: Array<Error | RoleProbe | "silent">): (() => Promise<RoleProbe>) => {
  const queue = [...outcomes];
  return async () => {
    const outcome = queue.shift() ?? APP;
    if (outcome === "silent") {
      return await new Promise<RoleProbe>(() => undefined);
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return await Promise.resolve(outcome);
  };
};

describe("retryDelayMs", () => {
  it("doubles from 250 ms and stays at 10 s", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 30].map((attempt) => retryDelayMs(attempt));

    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  });
});

describe("isUnreachable", () => {
  it.each([
    ["a refused connection", systemError("ECONNREFUSED"), true],
    ["an unknown host", systemError("ENOTFOUND"), true],
    ["an unreachable host", systemError("EHOSTUNREACH"), true],
    ["a dropped connection", new Error("Connection terminated unexpectedly"), true],
    ["a full pool", new Error("timeout exceeded when trying to connect"), true],
    ["a probe without an answer", new ProbeTimeoutError(), true],
    ["a server that is starting", postgresError("57P03"), true],
    ["a server that shuts down", postgresError("57P01"), true],
    ["too many connections", postgresError("53300"), true],
    ["a connection failure class 08", postgresError("08006"), true],
    ["a wrong password", postgresError("28P01"), false],
    ["a missing database", postgresError("3D000"), false],
    ["a folder PGlite may not write", systemError("EACCES"), false],
    ["an error without a code", new Error("something else"), false],
    ["a thrown string", "down", false],
  ])("says %s is %s", (_case, error, expected) => {
    expect(isUnreachable(error)).toBe(expected);
  });
});

describe("connectDatabase", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries an unreachable database with backoff, warning each time, until it answers", async () => {
    const warnings: string[] = [];
    const options = {
      probe: probeAnswering(systemError("ECONNREFUSED"), systemError("ECONNREFUSED")),
      timers,
      warnCollapsed: (key: string) => {
        warnings.push(key);
      },
    };

    const connecting = connectDatabase(options, new AbortController().signal);
    let settled = false;
    void connecting.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(250 + 499);
    const settledBeforeSecondDelay = settled;
    await vi.advanceTimersByTimeAsync(1);

    await expect(connecting).resolves.toBeUndefined();
    expect(settledBeforeSecondDelay).toBe(false);
    expect(warnings).toEqual(["db.unreachable", "db.unreachable"]);
  });

  it("counts a probe without an answer in 5 s as unreachable, and retries", async () => {
    const warnings: unknown[] = [];
    const options = {
      probe: probeAnswering("silent"),
      timers,
      warnCollapsed: (_key: string, fields: Record<string, unknown>) => {
        warnings.push(fields.err);
      },
    };

    const connecting = connectDatabase(options, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5000 + 250);

    await expect(connecting).resolves.toBeUndefined();
    expect(warnings).toEqual([expect.any(ProbeTimeoutError)]);
  });

  it("fails at once on an error that waiting does not end, without a warning", async () => {
    const warnings: string[] = [];
    const refused = postgresError("28P01");
    const options = {
      probe: probeAnswering(refused),
      timers,
      warnCollapsed: (key: string) => {
        warnings.push(key);
      },
    };

    await expect(connectDatabase(options, new AbortController().signal)).rejects.toBe(refused);
    expect(warnings).toEqual([]);
  });

  it.each([
    ["a superuser", { ...APP, role: "postgres", isSuperuser: true }, "SUPERUSER"],
    ["a role with BYPASSRLS", { ...APP, bypassesRls: true }, "BYPASSRLS"],
  ])("refuses %s", async (_case, probe, attribute) => {
    const options = { probe: probeAnswering(probe), timers, warnCollapsed: () => undefined };

    const connecting = connectDatabase(options, new AbortController().signal);

    await expect(connecting).rejects.toThrow(DatabaseRoleError);
    await expect(connecting).rejects.toThrow(attribute);
  });

  it("ends the wait between retries at once when the stop aborts the start", async () => {
    const aborter = new AbortController();
    const probe = vi.fn(probeAnswering(systemError("ECONNREFUSED")));
    const options = { probe, timers, warnCollapsed: () => undefined };
    const connecting = connectDatabase(options, aborter.signal);
    await vi.advanceTimersByTimeAsync(0);

    aborter.abort(new Error("the hub stops"));

    await expect(connecting).rejects.toThrow("the hub stops");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("ends a probe that waits for an answer at once when the stop aborts the start", async () => {
    const aborter = new AbortController();
    const options = { probe: probeAnswering("silent"), timers, warnCollapsed: () => undefined };
    const connecting = connectDatabase(options, aborter.signal);
    await vi.advanceTimersByTimeAsync(0);

    aborter.abort(new Error("the hub stops"));

    await expect(connecting).rejects.toThrow("the hub stops");
  });
});

describe("connect on PGlite", () => {
  const opened: Database[] = [];

  const openPglite = (): Database => {
    const db = createDatabase({
      url: "pglite:memory",
      poolSize: 1,
      log: pino({ level: "silent" }),
      warnCollapsed: () => undefined,
    });
    opened.push(db);
    return db;
  };

  const connectNow = async (db: Database): Promise<void> => {
    await connect(db, { timers, warnCollapsed: () => undefined }, new AbortController().signal);
  };

  afterEach(async () => {
    await Promise.all(
      opened.splice(0).map(async (db) => {
        await db.close();
      }),
    );
  });

  it("passes as the app role", async () => {
    const db = openPglite();

    await expect(connectNow(db)).resolves.toBeUndefined();
  });

  // PGlite's session user is a superuser, so the test can take back the role the adapter gave up
  it("refuses the session's superuser", async () => {
    const db = openPglite();
    await sql`reset role`.execute(db.global);

    await expect(connectNow(db)).rejects.toThrow(/postgres has SUPERUSER/);
  });

  it("refuses a role with BYPASSRLS", async () => {
    const db = openPglite();
    await sql`reset role`.execute(db.global);
    await sql`create role bypasser nosuperuser bypassrls`.execute(db.global);
    await sql`set role bypasser`.execute(db.global);

    await expect(connectNow(db)).rejects.toThrow(/bypasser has BYPASSRLS/);
  });
});

describe.runIf(isOnPostgres)("connect on Postgres", () => {
  const opened: TestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(
      opened.splice(0).map(async (test) => {
        await test.close();
      }),
    );
  });

  const connectTo = async (url: string): Promise<void> => {
    const db = createDatabase({ url, poolSize: 1, log: pino({ level: "silent" }), warnCollapsed: () => undefined });
    try {
      await connect(db, { timers, warnCollapsed: () => undefined }, new AbortController().signal);
    } finally {
      await db.close();
    }
  };

  it("fails at once when the server refuses the password, instead of retrying", async () => {
    const test = await openTestDatabase();
    opened.push(test);
    const wrong = new URL(test.url);
    wrong.password = "not-the-password";

    await expect(connectTo(wrong.toString())).rejects.toMatchObject({ code: "28P01" });
  });

  it("refuses an app role that has BYPASSRLS", async () => {
    const test = await openTestDatabase();
    opened.push(test);
    await test.alterRole("bypassrls");

    await expect(connectTo(test.url)).rejects.toThrow(/has BYPASSRLS/);
  });
});
