import type { BreakpointStatus } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  DEBUGGER_STATEMENT_SOURCE,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";

let test: BreakpointsUnderTest;

// The rate limits run on Date.now(), which the fake timers control: a pause takes no time unless a test says so
beforeEach(() => {
  vi.useFakeTimers();
  test = createBreakpoints();
});

afterEach(() => {
  test.dispose();
  vi.useRealTimers();
});

/** Line 4 of the checkout fixture: `sum += item.price`, hit once per item. */
const LOOP_LINE = 4;
/** Line 6: `return sum`, hit once per call. */
const RETURN_LINE = 6;

const HUNDRED_ITEMS = Array.from({ length: 100 }, () => ({ price: 1 }));
const TWENTY_ITEMS = HUNDRED_ITEMS.slice(0, 20);

const loadCheckout = () => test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));

const entry = (id: string, line: number, limits?: object) => ({
  id,
  file: test.fixtures.file("orders/checkout.cjs"),
  line,
  ...(limits === undefined ? {} : { limits }),
});

const status = (breakpointId: string, value: BreakpointStatus["status"]): BreakpointStatus => ({
  version: 1,
  type: "breakpointStatus",
  breakpointId,
  status: value,
});

const snapshotsOf = (breakpointId: string): number =>
  test.snapshots.filter((snapshot) => snapshot.breakpointId === breakpointId).length;

// Every pause from now on takes `ms` of the app's time, charged when the thread resumes
const makePausesTake = (ms: number): void => {
  test.session.beforePost = (method) => {
    if (method === "Debugger.resume") {
      vi.setSystemTime(Date.now() + ms);
    }
  };
};

describe("Pauses on a hot line", () => {
  it("captures 10 snapshots, sends rateLimited once and removes the V8 breakpoint, so V8 stops pausing", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", LOOP_LINE));

    module.total(HUNDRED_ITEMS);
    module.total(HUNDRED_ITEMS);

    expect({
      snapshots: snapshotsOf("bp-1"),
      pauses: test.session.pauses.length,
      sent: test.sent,
      removed: test.session.count("Debugger.removeBreakpoint"),
    }).toEqual({
      snapshots: 10,
      pauses: 11,
      sent: [status("bp-1", "active"), status("bp-1", "rateLimited")],
      removed: 1,
    });
  });

  it("sets the breakpoint again and sends active once its bucket is full, logged at debug", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", LOOP_LINE));
    module.total(HUNDRED_ITEMS);

    vi.advanceTimersByTime(1000);
    module.total(TWO_ITEMS);

    expect({
      lastSent: test.sent.at(-1),
      refilled: test.messagesAt("debug").filter((line) => line.startsWith("rate limits refilled")),
      snapshots: snapshotsOf("bp-1"),
    }).toEqual({
      lastSent: status("bp-1", "active"),
      refilled: ["rate limits refilled; 1 breakpoints active again"],
      snapshots: 12,
    });
  });

  it("does not set the breakpoint again before its bucket is full", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", LOOP_LINE));
    module.total(HUNDRED_ITEMS);

    vi.advanceTimersByTime(900);
    module.total(TWO_ITEMS);

    expect({ lastSent: test.sent.at(-1), snapshots: snapshotsOf("bp-1") }).toEqual({
      lastSent: status("bp-1", "rateLimited"),
      snapshots: 10,
    });
  });

  it("keeps the V8 breakpoint for the entries on it that still have tokens", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", LOOP_LINE));
    module.total(HUNDRED_ITEMS.slice(0, 10));
    test.apply(entry("bp-1", LOOP_LINE), entry("bp-2", LOOP_LINE));

    module.total(HUNDRED_ITEMS.slice(0, 3));

    expect({
      bp1: snapshotsOf("bp-1"),
      bp2: snapshotsOf("bp-2"),
      removed: test.session.count("Debugger.removeBreakpoint"),
      limited: test.sent.filter((sent) => sent.status === "rateLimited"),
    }).toEqual({ bp1: 10, bp2: 3, removed: 0, limited: [status("bp-1", "rateLimited")] });
  });

  it("keeps an entry's spent bucket when the list changes it", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", LOOP_LINE));
    module.total(HUNDRED_ITEMS);
    test.apply(entry("bp-1", LOOP_LINE, { maxDepth: 1 }));

    module.total(TWO_ITEMS);

    expect({ snapshots: snapshotsOf("bp-1"), lastSent: test.sent.at(-1) }).toEqual({
      snapshots: 10,
      lastSent: status("bp-1", "rateLimited"),
    });
  });

  it("starts an entry removed from the list and listed again with a full bucket", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", LOOP_LINE));
    module.total(HUNDRED_ITEMS);
    test.apply();
    test.apply(entry("bp-1", LOOP_LINE));

    module.total(TWO_ITEMS);

    expect(snapshotsOf("bp-1")).toBe(12);
  });
});

describe("Pauses over the process's limits", () => {
  const sixOnTheLoop = () => ["bp-0", "bp-1", "bp-2", "bp-3", "bp-4", "bp-5"].map((id) => entry(id, LOOP_LINE));

  it("turns every breakpoint off after 50 snapshots and sends rateLimited to every active entry", () => {
    const module = loadCheckout();
    test.apply(...sixOnTheLoop(), entry("bp-idle", RETURN_LINE));
    const sentBefore = test.sent.length;

    module.total(TWENTY_ITEMS);

    expect({
      snapshots: test.snapshots.length,
      pauses: test.session.pauses.length,
      turnedOff: test.session.posted.filter(({ method }) => method === "Debugger.setBreakpointsActive"),
      limited: test.sent.slice(sentBefore).map((sent) => `${sent.breakpointId} ${sent.status}`),
    }).toEqual({
      snapshots: 50,
      pauses: 9,
      turnedOff: [{ method: "Debugger.setBreakpointsActive", params: { active: false } }],
      limited: [
        "bp-0 rateLimited",
        "bp-1 rateLimited",
        "bp-2 rateLimited",
        "bp-3 rateLimited",
        "bp-4 rateLimited",
        "bp-5 rateLimited",
        "bp-idle rateLimited",
      ],
    });
  });

  it("turns the breakpoints on again and sends active once the process's bucket is full", () => {
    const module = loadCheckout();
    test.apply(...sixOnTheLoop(), entry("bp-idle", RETURN_LINE));
    module.total(TWENTY_ITEMS);
    const sentBefore = test.sent.length;

    vi.advanceTimersByTime(1000);

    expect({
      info: test.messagesAt("info").filter((line) => line.includes("refilled")),
      turnedOn: test.session.posted.filter(({ method }) => method === "Debugger.setBreakpointsActive").at(-1),
      active: test.sent.slice(sentBefore).map((sent) => `${sent.breakpointId} ${sent.status}`),
    }).toEqual({
      info: ["the process's rate limits refilled; 7 breakpoints active again"],
      turnedOn: { method: "Debugger.setBreakpointsActive", params: { active: true } },
      active: [
        "bp-0 active",
        "bp-1 active",
        "bp-2 active",
        "bp-3 active",
        "bp-4 active",
        "bp-5 active",
        "bp-idle active",
      ],
    });
  });

  it("charges each pause's time to the budget and turns breakpoints off once 20 ms a second are spent", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);

    module.total(TWO_ITEMS);
    module.total(TWO_ITEMS);

    expect({
      snapshots: snapshotsOf("bp-1"),
      pauses: test.session.pauses.length,
      lastSent: test.sent.at(-1),
    }).toEqual({ snapshots: 1, pauses: 1, lastSent: status("bp-1", "rateLimited") });
  });

  it("charges a pause it resumed at once, one none of its breakpoints caused", () => {
    loadCheckout();
    const module = test.fixtures.loadPause(test.fixtures.write("pause.cjs", DEBUGGER_STATEMENT_SOURCE));
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);

    module.pause();

    expect({ snapshots: test.snapshots.length, lastSent: test.sent.at(-1) }).toEqual({
      snapshots: 0,
      lastSent: status("bp-1", "rateLimited"),
    });
  });

  it("waits for a budget in debt to refill: a 25 ms pause turns breakpoints on after 1.25 s", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);
    module.total(TWO_ITEMS);
    makePausesTake(0);

    vi.advanceTimersByTime(1000);
    const before = test.sent.at(-1);
    vi.advanceTimersByTime(250);

    expect({ before, after: test.sent.at(-1) }).toEqual({
      before: status("bp-1", "rateLimited"),
      after: status("bp-1", "active"),
    });
  });

  it("sends rateLimited for an entry set while every breakpoint is off", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);
    module.total(TWO_ITEMS);

    test.apply(entry("bp-1", RETURN_LINE), entry("bp-2", LOOP_LINE));

    expect(test.sent.at(-1)).toEqual(status("bp-2", "rateLimited"));
  });

  it("reports the error when the inspector cannot turn the breakpoints off", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);
    test.session.failing.add("Debugger.setBreakpointsActive");

    module.total(TWO_ITEMS);

    expect(test.failures.map((failure) => (failure as Error).message)).toEqual([
      "the inspector could not turn the breakpoints off",
    ]);
  });

  it("counts entries set while every breakpoint is off as rate limited in the list's summary", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);
    module.total(TWO_ITEMS);

    test.apply(entry("bp-1", RETURN_LINE), entry("bp-2", LOOP_LINE));
    // Lines written after a pause wait for the logger's setImmediate
    vi.advanceTimersByTime(0);

    expect(test.messagesAt("info").at(-1)).toBe("0 active, 0 pending, 0 error, 2 rate limited");
  });

  it("reports the error when the inspector cannot turn the breakpoints on again", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);
    module.total(TWO_ITEMS);
    test.session.failing.add("Debugger.setBreakpointsActive");

    vi.advanceTimersByTime(1250);

    expect(test.failures.map((failure) => (failure as Error).message)).toEqual([
      "the inspector could not turn the breakpoints on",
    ]);
  });

  it("keeps every breakpoint off through an emptied list and turns them on once the limits refill", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);
    module.total(TWO_ITEMS);
    makePausesTake(0);
    test.apply();
    test.apply(entry("bp-1", RETURN_LINE));

    // V8 keeps breakpoints off across Debugger.disable and enable, so only the restore timer turns them on
    vi.advanceTimersByTime(1250);
    module.total(TWO_ITEMS);

    expect({
      sent: test.sent.slice(-1),
      snapshots: snapshotsOf("bp-1"),
      failures: test.failures,
    }).toEqual({ sent: [status("bp-1", "active")], snapshots: 2, failures: [] });
  });

  it("clears the restore timer when it stops", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", RETURN_LINE));
    makePausesTake(25);
    module.total(TWO_ITEMS);

    test.breakpoints.stop();
    test.pauses.stop();
    vi.advanceTimersByTime(2000);

    expect(test.session.posted.filter(({ method }) => method === "Debugger.setBreakpointsActive")).toEqual([
      { method: "Debugger.setBreakpointsActive", params: { active: false } },
    ]);
  });
});

describe("Pauses setting a breakpoint again", () => {
  it("sends error when the line has no code any more once the bucket is full", () => {
    const module = loadCheckout();
    test.apply(entry("bp-1", LOOP_LINE));
    module.total(HUNDRED_ITEMS);
    test.session.answers.set("Debugger.setBreakpointByUrl", { breakpointId: "gone", locations: [] });

    vi.advanceTimersByTime(1000);

    expect(test.sent.at(-1)).toEqual({
      ...status("bp-1", "error"),
      message: "no code at the breakpoint's line any more",
    });
  });
});

describe("Pauses ending the process's limits", () => {
  const fourOnTheLoop = () => ["x-0", "x-1", "x-2", "x-3"].map((id) => entry(id, LOOP_LINE));

  // The loop entries run out of tokens and leave V8 at 0 ms; at 10 ms bp-1 takes the process's last whole token and
  // its own last one: its bucket (1000 ms) is then the longest wait, longer than the process's (990 ms)
  const runOutWithBp1Last = (module: ReturnType<typeof loadCheckout>): void => {
    test.apply(...fourOnTheLoop());
    module.total(HUNDRED_ITEMS.slice(0, 11));
    vi.advanceTimersByTime(10);
    test.apply(...fourOnTheLoop(), entry("bp-1", RETURN_LINE));
    Array.from({ length: 10 }, () => module.total(TWO_ITEMS));
  };

  it("turns the breakpoints on only once every rate-limited entry's own bucket is full too", () => {
    const module = loadCheckout();
    runOutWithBp1Last(module);
    const turnOns = () =>
      test.session.posted.filter(
        ({ method, params }) =>
          method === "Debugger.setBreakpointsActive" && params !== undefined && Reflect.get(params, "active") === true,
      ).length;

    vi.advanceTimersByTime(995);
    const before = { turnOns: turnOns(), bp1: test.sent.filter((sent) => sent.breakpointId === "bp-1").at(-1)?.status };
    vi.advanceTimersByTime(10);

    expect({
      before,
      after: turnOns(),
      bp1: test.sent.filter((sent) => sent.breakpointId === "bp-1").at(-1)?.status,
    }).toEqual({
      before: { turnOns: 0, bp1: "rateLimited" },
      after: 1,
      bp1: "active",
    });
  });

  it("sets again the entries that left V8 for their own limit when every breakpoint comes back", () => {
    const module = loadCheckout();
    runOutWithBp1Last(module);
    vi.advanceTimersByTime(1005);

    module.total(TWO_ITEMS);

    expect({
      loop: ["x-0", "x-1", "x-2", "x-3"].map((id) => snapshotsOf(id)),
      bp1: snapshotsOf("bp-1"),
      failures: test.failures,
    }).toEqual({ loop: [12, 12, 12, 12], bp1: 11, failures: [] });
  });
});
