import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readBreakpoints } from "../breakpoints.js";

const SAMPLE = [{ id: "bp-quote", file: "examples/frameworks/fastify/src/pricing.ts", line: 33 }];
const OVERRIDE = [{ id: "bp-missing", file: "src/missing.ts", line: 1 }];

const DIR = mkdtempSync(path.join(tmpdir(), "fake-hub-"));

// One file per test, so no test reads another's
const writeBreakpointsFile = (name: string, json: string): string => {
  const file = path.join(DIR, `${name}.json`);
  writeFileSync(file, json);
  return file;
};

// The variables as the process environment holds them, by their wire names
const envOf = (...entries: Array<[string, string]>): NodeJS.ProcessEnv => Object.fromEntries(entries);

describe("readBreakpoints", () => {
  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it("returns no breakpoints when neither HUB_BREAKPOINTS nor HUB_BREAKPOINTS_FILE is set", () => {
    const breakpoints = readBreakpoints(envOf());

    expect(breakpoints).toEqual([]);
  });

  it("reads the breakpoints of the file HUB_BREAKPOINTS_FILE names", () => {
    const file = writeBreakpointsFile("sample", JSON.stringify(SAMPLE));

    const breakpoints = readBreakpoints(envOf(["HUB_BREAKPOINTS_FILE", file]));

    expect(breakpoints).toEqual(SAMPLE);
  });

  it("takes HUB_BREAKPOINTS over HUB_BREAKPOINTS_FILE when both are set", () => {
    const file = writeBreakpointsFile("both", JSON.stringify(SAMPLE));

    const breakpoints = readBreakpoints(
      envOf(["HUB_BREAKPOINTS", JSON.stringify(OVERRIDE)], ["HUB_BREAKPOINTS_FILE", file]),
    );

    expect(breakpoints).toEqual(OVERRIDE);
  });

  it("throws naming HUB_BREAKPOINTS_FILE when the file holds no array", () => {
    const file = writeBreakpointsFile("object", JSON.stringify(SAMPLE[0]));

    expect(() => readBreakpoints(envOf(["HUB_BREAKPOINTS_FILE", file]))).toThrow(
      /HUB_BREAKPOINTS_FILE must be a JSON array/,
    );
  });
});
