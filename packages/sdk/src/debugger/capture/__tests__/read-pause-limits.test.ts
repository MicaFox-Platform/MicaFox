import type { Value } from "@micafox/protocol";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { readRealPause, type RealPauseOptions } from "../../../../test/capture/real-pause.js";

const KIB = 1024;
// The budget is checked before each value, so the value that crosses 64 KiB is still kept: one string of 4096 ASCII
// characters with its field names. The margin covers that one value, not a growing overshoot
const MAX_TRUNCATED_BYTES = 64 * KIB + 8 * KIB;
const SIZE_LIMIT_REASON = "the snapshot reached its size limit";

const number = (value: number): Value => ({ type: "number", value });

// The variables are declared in a function of the real V8 of the test process, read with the breakpoint's `limits`
const valueOf = (body: string, limits: NonNullable<RealPauseOptions["limits"]>): Value | undefined =>
  readRealPause(body, { limits }).read.variables.find((variable) => variable.name === "v")?.value;

describe("readPause with the limits of a breakpoint", () => {
  it("keeps a fifth level with the breakpoint's maxDepth of 5", () => {
    const value = valueOf("const v = { a: { b: { c: { d: { e: 1 } } } } };", [{ maxDepth: 5 }]);

    expect(JSON.stringify(value)).toBe(
      '{"type":"object","className":"Object","properties":[{"name":"a","value":{"type":"object","className":"Object",' +
        '"properties":[{"name":"b","value":{"type":"object","className":"Object","properties":[{"name":"c","value":' +
        '{"type":"object","className":"Object","properties":[{"name":"d","value":{"type":"object","className":"Object",' +
        '"properties":[{"name":"e","value":{"type":"number","value":1}}]}}]}}]}}]}}]}',
    );
  });

  it("keeps only the size of a collection above the breakpoint's maxItems of 2, and the items of one within it", () => {
    const values = [
      valueOf("const v = [1, 2, 3];", [{ maxItems: 2 }]),
      valueOf("const v = new Set([1, 2]);", [{ maxItems: 2 }]),
    ];

    expect(values).toEqual([
      { type: "array", length: 3 },
      { type: "set", size: 2, items: [number(1), number(2)] },
    ]);
  });

  it("truncates the read near 64 KiB of JSON and says why in the first value it did not read", () => {
    const { read } = readRealPause(
      "const v = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['part' + i, 'y'.repeat(4096)]));",
      { limits: [{ maxItems: 100, maxStringLength: 4096 }] },
    );

    const value = read.variables.find((variable) => variable.name === "v")?.value;
    const properties = value?.type === "object" ? (value.properties ?? []) : [];
    expect({
      truncated: read.truncated,
      lastProperty: properties.at(-1)?.value,
      isWithinSize: Buffer.byteLength(JSON.stringify(read)) <= MAX_TRUNCATED_BYTES,
    }).toEqual({
      truncated: true,
      lastProperty: { type: "unavailable", reason: SIZE_LIMIT_REASON },
      isWithinSize: true,
    });
  });
});
