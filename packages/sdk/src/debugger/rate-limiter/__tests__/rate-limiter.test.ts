import { describe, expect, it } from "vitest";

import { RateLimiter } from "../index.js";

const createClock = () => {
  let nowMs = 1000;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

const ids = (count: number, prefix = "bp"): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index)}`);

// Admits `id` alone `times` times and returns how many were allowed and how many found it out of tokens
const admitRepeatedly = (limiter: RateLimiter, id: string, times: number): { allowed: number; outOfTokens: number } =>
  Array.from({ length: times }, () => limiter.admit([id])).reduce(
    (sum, admission) => ({
      allowed: sum.allowed + admission.allowed.length,
      outOfTokens: sum.outOfTokens + admission.outOfTokens.length,
    }),
    { allowed: 0, outOfTokens: 0 },
  );

describe("RateLimiter", () => {
  it("allows an entry 10 times, then finds it out of tokens", () => {
    const limiter = new RateLimiter(createClock().now);

    expect(admitRepeatedly(limiter, "bp-1", 12)).toEqual({ allowed: 10, outOfTokens: 2 });
  });

  it("refills an entry's bucket continuously, one token per 100 ms", () => {
    const clock = createClock();
    const limiter = new RateLimiter(clock.now);
    admitRepeatedly(limiter, "bp-1", 10);

    clock.advance(250);

    expect(admitRepeatedly(limiter, "bp-1", 3)).toEqual({ allowed: 2, outOfTokens: 1 });
  });

  it("gives each entry its own bucket", () => {
    const limiter = new RateLimiter(createClock().now);
    admitRepeatedly(limiter, "bp-1", 10);

    expect(limiter.admit(["bp-1", "bp-2"])).toEqual({ allowed: ["bp-2"], outOfTokens: ["bp-1"] });
  });

  it("allows 50 captures in the process, then refuses entries that still have tokens without calling them out", () => {
    const limiter = new RateLimiter(createClock().now);
    const entries = ids(6);
    const admissions = Array.from({ length: 9 }, () => limiter.admit(entries));

    expect({
      allowed: admissions.reduce((sum, admission) => sum + admission.allowed.length, 0),
      last: admissions.at(-1),
      isSpent: limiter.isSpent(),
    }).toEqual({ allowed: 50, last: { allowed: ["bp-0", "bp-1"], outOfTokens: [] }, isSpent: true });
  });

  it("refuses every entry once 20 ms of pauses are charged within a second", () => {
    const limiter = new RateLimiter(createClock().now);

    limiter.charge(20);

    expect({ isSpent: limiter.isSpent(), admission: limiter.admit(["bp-1"]) }).toEqual({
      isSpent: true,
      admission: { allowed: [], outOfTokens: [] },
    });
  });

  it("is not spent with budget left", () => {
    const limiter = new RateLimiter(createClock().now);

    limiter.charge(19.5);

    expect(limiter.isSpent()).toBe(false);
  });

  it("refills a budget in debt from below zero: a 30 ms pause takes 1.5 s to be full again", () => {
    const limiter = new RateLimiter(createClock().now);

    limiter.charge(30);

    expect(limiter.msUntilProcessFull()).toBe(1500);
  });

  it("tells when an entry's bucket is full again, and 0 for an entry it never saw", () => {
    const clock = createClock();
    const limiter = new RateLimiter(clock.now);
    admitRepeatedly(limiter, "bp-1", 10);

    clock.advance(400);

    expect({ used: limiter.msUntilEntryFull("bp-1"), unseen: limiter.msUntilEntryFull("bp-2") }).toEqual({
      used: 600,
      unseen: 0,
    });
  });

  it("starts a forgotten entry with a full bucket", () => {
    const limiter = new RateLimiter(createClock().now);
    admitRepeatedly(limiter, "bp-1", 10);

    limiter.forget("bp-1");

    expect(limiter.admit(["bp-1"])).toEqual({ allowed: ["bp-1"], outOfTokens: [] });
  });
});
