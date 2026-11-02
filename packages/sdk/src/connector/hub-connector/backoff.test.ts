import { afterEach, describe, expect, it, vi } from "vitest";

import { Backoff } from "./backoff.js";

const waits = (backoff: Backoff, count: number): number[] => Array.from({ length: count }, () => backoff.nextWaitMs());

describe("Backoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts at the minimum delay and doubles it up to the maximum", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);

    expect(waits(new Backoff(1000, 5000), 5)).toEqual([1000, 2000, 4000, 5000, 5000]);
  });

  it("waits half of the current delay when the random value is 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(waits(new Backoff(1000, 5000), 3)).toEqual([500, 1000, 2000]);
  });

  it("waits within half and all of the current delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(waits(new Backoff(1000, 5000), 2)).toEqual([750, 1500]);
  });

  it("goes back to the minimum delay after reset()", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const backoff = new Backoff(1000, 30_000);
    waits(backoff, 3);

    backoff.reset();

    expect(backoff.nextWaitMs()).toBe(1000);
  });

  it("uses the maximum delay right after jumpToMax()", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const backoff = new Backoff(1000, 30_000);

    backoff.jumpToMax();

    expect(waits(backoff, 2)).toEqual([30_000, 30_000]);
  });
});
