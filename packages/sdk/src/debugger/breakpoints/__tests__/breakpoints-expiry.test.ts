import type { BreakpointStatus } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeCompiled } from "../../../../test/debugger/compiled.js";
import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";

let test: BreakpointsUnderTest;

// The clock of the breakpoints is Date.now(), which the fake timers control; setImmediate stays real, as the waits for
// a source map read need it
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  test = createBreakpoints();
});

afterEach(() => {
  test.dispose();
  vi.useRealTimers();
});

/** Line 4 of the checkout fixture: `sum += item.price`, hit once per item. */
const LOOP_LINE = 4;
const RETURN_LINE = 6;
const HUNDRED_ITEMS = Array.from({ length: 100 }, () => ({ price: 1 }));
const LOADED = "source map loaded: ";

const loadCheckout = () => test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));

const entry = (id: string, expiresInMs: number, line = LOOP_LINE) => ({
  id,
  file: test.fixtures.file("orders/checkout.cjs"),
  line,
  expiresInMs,
});

const status = (breakpointId: string, value: BreakpointStatus["status"]): BreakpointStatus => ({
  version: 1,
  module: "debugger",
  type: "breakpointStatus",
  breakpointId,
  status: value,
});

describe("Breakpoints expiring an entry", () => {
  it("sends expired once when the time left runs out, and removes the V8 breakpoint and the domain", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000));

    vi.advanceTimersByTime(999);
    const before = test.sent.slice();
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(5000);

    expect({ before, sent: test.sent, methods: test.session.methods }).toEqual({
      before: [status("bp-1", "active")],
      sent: [status("bp-1", "active"), status("bp-1", "expired")],
      methods: ["Debugger.enable", "Debugger.setBreakpointByUrl", "Debugger.removeBreakpoint", "Debugger.disable"],
    });
  });

  it("counts the time left from the arrival of the list", () => {
    loadCheckout();
    vi.advanceTimersByTime(10_000);
    test.apply(entry("bp-1", 1000));

    vi.advanceTimersByTime(999);
    const before = test.sent.at(-1);
    vi.advanceTimersByTime(1);

    expect({ before, after: test.sent.at(-1) }).toEqual({
      before: status("bp-1", "active"),
      after: status("bp-1", "expired"),
    });
  });

  it("no longer pauses the app at an expired entry", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", 1000));
    vi.advanceTimersByTime(1000);

    module.total(TWO_ITEMS);

    expect(test.snapshots).toEqual([]);
  });

  it("expires a pending entry that no script has resolved", () => {
    test.apply(entry("bp-1", 1000));

    vi.advanceTimersByTime(1000);

    expect(test.sent).toEqual([status("bp-1", "pending"), status("bp-1", "expired")]);
  });

  it("expires each entry at its own deadline and keeps the domain on while one is left", () => {
    loadCheckout();
    test.apply(entry("bp-1", 3000), entry("bp-2", 1000, RETURN_LINE), entry("bp-3", 2000));

    vi.advanceTimersByTime(1000);
    const afterFirst = { sent: test.sent.slice(3), disables: test.session.count("Debugger.disable") };
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect({ afterFirst, expired: test.sent.slice(3), disables: test.session.count("Debugger.disable") }).toEqual({
      afterFirst: { sent: [status("bp-2", "expired")], disables: 0 },
      expired: [status("bp-2", "expired"), status("bp-3", "expired"), status("bp-1", "expired")],
      disables: 1,
    });
  });

  it("removes a V8 breakpoint that entries share only with its last entry", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000), entry("bp-2", 2000));

    vi.advanceTimersByTime(1000);
    const removedAfterFirst = test.session.count("Debugger.removeBreakpoint");
    vi.advanceTimersByTime(1000);

    expect({ removedAfterFirst, removed: test.session.count("Debugger.removeBreakpoint") }).toEqual({
      removedAfterFirst: 0,
      removed: 1,
    });
  });

  it("turns the domain off when only invalid entries are left after the last valid one expires", () => {
    test.apply(entry("bp-1", 1000), { id: "bp-2", file: "", line: 1, expiresInMs: 1000 });

    vi.advanceTimersByTime(1000);

    expect(test.session.count("Debugger.disable")).toBe(1);
  });

  it("drops the source map index the expired entry held", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    loadCheckout();
    test.apply(entry("bp-2", 60_000), { id: "bp-1", file: compiled.file, line: 8, expiresInMs: 1000 });
    await test.waitForLine("debug", LOADED);
    vi.advanceTimersByTime(1000);

    test.apply(entry("bp-2", 60_000), { id: "bp-3", file: compiled.file, line: 8, expiresInMs: 1000 });
    await test.waitForLine("debug", LOADED);

    expect(test.messagesAt("debug").filter((line) => line.startsWith(LOADED))).toHaveLength(2);
  });
});

describe("Breakpoints expiring an entry in other states", () => {
  it("removes the V8 breakpoint of an entry that every breakpoint being off made rateLimited", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000));
    test.breakpoints.rateLimitAll();

    vi.advanceTimersByTime(1000);

    expect({
      sent: test.sent.slice(1),
      removed: test.session.count("Debugger.removeBreakpoint"),
      isAllRateLimited: test.breakpoints.isAllRateLimited(),
    }).toEqual({
      sent: [status("bp-1", "rateLimited"), status("bp-1", "expired")],
      removed: 1,
      isAllRateLimited: true,
    });
  });

  it("does not turn the domain off again after it was turned off from outside", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000));
    test.breakpoints.forgetDomain();

    vi.advanceTimersByTime(1000);

    expect({ last: test.sent.at(-1), disables: test.session.count("Debugger.disable") }).toEqual({
      last: status("bp-1", "expired"),
      disables: 0,
    });
  });

  it("drops the V8 breakpoint and the deadline of an entry that a later list makes invalid with its time left", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000));

    test.apply({ ...entry("bp-1", 1000), expiresInMs: -1 });
    vi.advanceTimersByTime(1000);

    expect({
      sent: test.sent,
      removed: test.session.count("Debugger.removeBreakpoint"),
    }).toEqual({
      sent: [
        status("bp-1", "active"),
        { ...status("bp-1", "error"), message: "expiresInMs must be an integer of at least 0" },
      ],
      removed: 1,
    });
  });
});

describe("Breakpoints reading the time left of a list", () => {
  it("expires an entry with 0 left in the reply to its list, with no V8 call", () => {
    loadCheckout();

    test.apply(entry("bp-1", 0));

    expect({ sent: test.sent, methods: test.session.methods, timers: vi.getTimerCount() }).toEqual({
      sent: [status("bp-1", "expired")],
      methods: [],
      timers: 0,
    });
  });

  it("expires an active entry whose list now gives it 0 left, and removes its V8 breakpoint", () => {
    loadCheckout();
    test.apply(entry("bp-1", 60_000));

    test.apply(entry("bp-1", 0));

    expect({ sent: test.sent, removed: test.session.count("Debugger.removeBreakpoint") }).toEqual({
      sent: [status("bp-1", "active"), status("bp-1", "expired")],
      removed: 1,
    });
  });

  it("lowers a time over 24 h to 24 h", () => {
    loadCheckout();
    test.apply(entry("bp-1", 2 ** 40));

    vi.advanceTimersByTime(86_399_999);
    const before = test.sent.at(-1);
    vi.advanceTimersByTime(1);

    expect({ before, after: test.sent.at(-1) }).toEqual({
      before: status("bp-1", "active"),
      after: status("bp-1", "expired"),
    });
  });

  it.each([
    ["a missing time", undefined],
    ["a fractional time", 1.5],
    ["a negative time", -1],
  ])("gives %s status error and sets no V8 breakpoint", (_name, expiresInMs) => {
    loadCheckout();

    test.apply({ ...entry("bp-1", 1000), expiresInMs });

    expect({ sent: test.sent, methods: test.session.methods, timers: vi.getTimerCount() }).toEqual({
      sent: [{ ...status("bp-1", "error"), message: "expiresInMs must be an integer of at least 0" }],
      methods: [],
      timers: 0,
    });
  });

  it("extends the deadline of an entry that a later list gives more time, with no V8 call", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000));
    vi.advanceTimersByTime(900);

    test.apply(entry("bp-1", 1000));
    vi.advanceTimersByTime(999);
    const stillActive = test.sent.at(-1);
    vi.advanceTimersByTime(1);

    expect({
      stillActive,
      expired: test.sent.at(-1),
      set: test.session.count("Debugger.setBreakpointByUrl"),
    }).toEqual({ stillActive: status("bp-1", "active"), expired: status("bp-1", "expired"), set: 1 });
  });

  it("shortens the deadline of an entry that a later list gives less time, with no V8 call", () => {
    loadCheckout();
    test.apply(entry("bp-1", 60_000));

    test.apply(entry("bp-1", 500));
    const removedBefore = test.session.count("Debugger.removeBreakpoint");
    vi.advanceTimersByTime(500);

    expect({
      removedBefore,
      last: test.sent.at(-1),
      set: test.session.count("Debugger.setBreakpointByUrl"),
    }).toEqual({ removedBefore: 0, last: status("bp-1", "expired"), set: 1 });
  });

  it("sets one unref'd timer to the nearest deadline", () => {
    loadCheckout();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    test.apply(entry("bp-1", 3000), entry("bp-2", 1000), entry("bp-3", 2000));
    const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;

    expect({
      timers: vi.getTimerCount(),
      hasRef: timer.hasRef(),
      waitMs: setTimeoutSpy.mock.calls.at(-1)?.[1],
    }).toEqual({
      timers: 1,
      hasRef: false,
      waitMs: 1000,
    });
  });
});

describe("Breakpoints holding an expired entry", () => {
  it("repeats expired in the reply to every list that holds the id, whatever its fields, with the domain off", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000));
    vi.advanceTimersByTime(1000);

    test.apply(entry("bp-1", 60_000));
    test.apply({ ...entry("bp-1", 60_000), line: RETURN_LINE });
    test.apply({ id: "bp-1", file: "", line: 0 });

    expect({
      replies: test.sent.slice(2),
      set: test.session.count("Debugger.setBreakpointByUrl"),
      enables: test.session.count("Debugger.enable"),
    }).toEqual({
      replies: [status("bp-1", "expired"), status("bp-1", "expired"), status("bp-1", "expired")],
      set: 1,
      enables: 1,
    });
  });

  it("never sets it again when a script it matches loads", () => {
    test.apply(entry("bp-1", 1000));
    vi.advanceTimersByTime(1000);

    loadCheckout();

    expect({ sent: test.sent, set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "expired")],
      set: 0,
    });
  });

  it("never sets it again when a source map read ends", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    loadCheckout();
    // The second entry keeps the domain on, so the read still ends
    test.apply({ id: "bp-1", file: compiled.file, line: 8, expiresInMs: 1000 }, entry("bp-2", 60_000));
    vi.advanceTimersByTime(1000);

    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent.filter((sent) => sent.breakpointId === "bp-1"),
      set: test.session.count("Debugger.setBreakpointByUrl"),
    }).toEqual({ sent: [status("bp-1", "pending"), status("bp-1", "expired")], set: 1 });
  });

  it("is not restored by the rate limits", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", 500));
    module.total(HUNDRED_ITEMS);
    vi.advanceTimersByTime(500);

    vi.advanceTimersByTime(60_000);

    expect({ sent: test.sent.slice(1), set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "rateLimited"), status("bp-1", "expired")],
      set: 1,
    });
  });

  it("forgets the id when a list leaves it out, so listing it again makes a fresh entry", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000));
    vi.advanceTimersByTime(1000);
    test.apply(entry("bp-2", 60_000));

    test.apply(entry("bp-1", 60_000));

    expect({ sent: test.sent.slice(2), set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-2", "active"), status("bp-1", "active")],
      set: 3,
    });
  });
});

describe("Breakpoints stopping with entries that expire", () => {
  it("clears the timer and forgets the expired ids", () => {
    loadCheckout();
    test.apply(entry("bp-1", 1000), entry("bp-2", 60_000));
    vi.advanceTimersByTime(1000);

    test.breakpoints.stop();
    const timers = vi.getTimerCount();
    test.breakpoints.start();
    test.apply(entry("bp-1", 60_000));

    expect({ timers, last: test.sent.at(-1) }).toEqual({ timers: 0, last: status("bp-1", "active") });
  });
});
