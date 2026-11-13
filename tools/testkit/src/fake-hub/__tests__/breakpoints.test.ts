import { describe, expect, it } from "vitest";

import { DEFAULT_EXPIRES_IN_MS, readBreakpoints, startCountdown } from "../breakpoints.js";

const SAMPLE = [{ id: "bp-quote", file: "examples/frameworks/fastify/src/pricing.ts", line: 33 }];

// The variables as the process environment holds them, by their wire names
const envOf = (...entries: Array<[string, string]>): NodeJS.ProcessEnv => Object.fromEntries(entries);

describe("readBreakpoints", () => {
  it("returns no breakpoints when HUB_BREAKPOINTS is unset", () => {
    const breakpoints = readBreakpoints(envOf());

    expect(breakpoints).toEqual([]);
  });

  it("returns no breakpoints when HUB_BREAKPOINTS is empty, as a `.env` line `HUB_BREAKPOINTS=` leaves it", () => {
    const breakpoints = readBreakpoints(envOf(["HUB_BREAKPOINTS", ""]));

    expect(breakpoints).toEqual([]);
  });

  it("reads the breakpoints HUB_BREAKPOINTS holds as JSON", () => {
    const breakpoints = readBreakpoints(envOf(["HUB_BREAKPOINTS", JSON.stringify(SAMPLE)]));

    expect(breakpoints).toEqual(SAMPLE);
  });

  it("throws naming HUB_BREAKPOINTS when it holds no array", () => {
    expect(() => readBreakpoints(envOf(["HUB_BREAKPOINTS", JSON.stringify(SAMPLE[0])]))).toThrow(
      /HUB_BREAKPOINTS must be a JSON array/,
    );
  });
});

// A clock the test moves by hand
const createClock = (start: number): { now: () => number; advance: (ms: number) => void } => {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
};

const ENTRY = { id: "bp-quote", file: "src/pricing.ts", line: 33 };

describe("startCountdown", () => {
  it("sends the expiresInMs of an entry at the start", () => {
    const clock = createClock(1_000_000);
    const list = startCountdown([{ ...ENTRY, expiresInMs: 60_000 }], clock.now);

    expect(list()).toEqual([{ ...ENTRY, expiresInMs: 60_000 }]);
  });

  it("counts the time left down from when the countdown started, on every send", () => {
    const clock = createClock(1_000_000);
    const list = startCountdown([{ ...ENTRY, expiresInMs: 60_000 }], clock.now);

    clock.advance(25_000);
    const first = list();
    clock.advance(10_000);
    const second = list();

    expect([first, second]).toEqual([[{ ...ENTRY, expiresInMs: 35_000 }], [{ ...ENTRY, expiresInMs: 25_000 }]]);
  });

  it("does not move the deadline when the list is built later than the countdown started", () => {
    const clock = createClock(0);
    const list = startCountdown([{ ...ENTRY, expiresInMs: 1000 }], clock.now);

    clock.advance(400);
    list();
    clock.advance(100);

    expect(list()).toEqual([{ ...ENTRY, expiresInMs: 500 }]);
  });

  it("sends 0, never less, once the deadline has passed", () => {
    const clock = createClock(0);
    const list = startCountdown([{ ...ENTRY, expiresInMs: 1000 }], clock.now);

    clock.advance(5000);

    expect(list()).toEqual([{ ...ENTRY, expiresInMs: 0 }]);
  });

  it("keeps an expiresInMs of 0", () => {
    const clock = createClock(0);
    const list = startCountdown([{ ...ENTRY, expiresInMs: 0 }], clock.now);

    expect(list()).toEqual([{ ...ENTRY, expiresInMs: 0 }]);
  });

  it.each([
    ["left out", undefined],
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "60000"],
    ["null", null],
    ["not finite", Number.POSITIVE_INFINITY],
  ])("gives an entry whose expiresInMs is %s the default of 1 h", (_name, expiresInMs) => {
    const clock = createClock(0);
    const list = startCountdown([{ ...ENTRY, expiresInMs }], clock.now);

    expect(list()).toEqual([{ ...ENTRY, expiresInMs: DEFAULT_EXPIRES_IN_MS }]);
  });

  it("counts the default down like any other time left", () => {
    const clock = createClock(0);
    const list = startCountdown([ENTRY], clock.now);

    clock.advance(600_000);

    expect(list()).toEqual([{ ...ENTRY, expiresInMs: 3_000_000 }]);
  });

  it("passes an entry that is not an object on as it is", () => {
    const clock = createClock(0);
    const list = startCountdown(["bp-quote", null], clock.now);

    expect(list()).toEqual(["bp-quote", null]);
  });

  it("counts each entry down from its own time", () => {
    const clock = createClock(0);
    const list = startCountdown(
      [
        { ...ENTRY, id: "a", expiresInMs: 1000 },
        { ...ENTRY, id: "b" },
      ],
      clock.now,
    );

    clock.advance(1500);

    expect(list()).toEqual([
      { ...ENTRY, id: "a", expiresInMs: 0 },
      { ...ENTRY, id: "b", expiresInMs: DEFAULT_EXPIRES_IN_MS - 1500 },
    ]);
  });

  it("returns no entries for no breakpoints", () => {
    const list = startCountdown([], createClock(0).now);

    expect(list()).toEqual([]);
  });
});
