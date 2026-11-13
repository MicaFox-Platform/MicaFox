import { describe, expect, it } from "vitest";

import { readBreakpoints } from "../breakpoints.js";

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
