import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Expiry } from "../expiry.js";

// The clock is the test's own, apart from the fake timers, so a timer can fire before the clock reaches the deadline
let nowMs: number;
let due: string[][];
let failures: unknown[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  nowMs = 0;
  due = [];
  failures = [];
});

afterEach(() => {
  vi.useRealTimers();
});

const createExpiry = (onDue: (ids: string[]) => void = (ids) => due.push(ids)): Expiry =>
  new Expiry({
    now: () => nowMs,
    onDue,
    fail: (error) => {
      failures.push(error);
    },
  });

describe("Expiry", () => {
  it("expires nothing and sets the timer again when it fires before the clock reaches the deadline", () => {
    const expiry = createExpiry();
    expiry.set("bp-1", 1000);
    expiry.schedule();

    nowMs = 999;
    vi.advanceTimersByTime(1000);
    const early = due.slice();
    nowMs = 1000;
    vi.advanceTimersByTime(1);

    expect({ early, due, timers: vi.getTimerCount() }).toEqual({ early: [], due: [["bp-1"]], timers: 0 });
  });

  it("reports every id past its deadline in one call and keeps the others", () => {
    const expiry = createExpiry();
    expiry.set("bp-1", 1000);
    expiry.set("bp-2", 1000);
    expiry.set("bp-3", 5000);
    expiry.schedule();

    nowMs = 1000;
    vi.advanceTimersByTime(1000);

    expect({ due, timers: vi.getTimerCount() }).toEqual({ due: [["bp-1", "bp-2"]], timers: 1 });
  });

  it("forgets a deleted id", () => {
    const expiry = createExpiry();
    expiry.set("bp-1", 1000);
    expiry.schedule();

    expiry.delete("bp-1");
    nowMs = 1000;
    vi.advanceTimersByTime(1000);

    expect(due).toEqual([]);
  });

  it("reports an error thrown while handling the due ids instead of throwing from the timer", () => {
    const expiry = createExpiry(() => {
      throw new Error("expiring failed");
    });
    expiry.set("bp-1", 1000);
    expiry.schedule();

    nowMs = 1000;
    vi.advanceTimersByTime(1000);

    expect(failures.map((failure) => (failure as Error).message)).toEqual(["expiring failed"]);
  });

  it("clears the timer and every deadline", () => {
    const expiry = createExpiry();
    expiry.set("bp-1", 1000);
    expiry.schedule();

    expiry.clear();
    nowMs = 1000;
    vi.advanceTimersByTime(1000);

    expect({ due, timers: vi.getTimerCount() }).toEqual({ due: [], timers: 0 });
  });
});
