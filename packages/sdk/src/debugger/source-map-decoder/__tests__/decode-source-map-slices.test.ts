import { afterEach, describe, expect, it, vi } from "vitest";

import { createLargeSourceMapText } from "../../../../test/source-maps/large-map.js";
import { decodeSourceMap, type SourceMapIndex } from "../index.js";

const EIGHT_MIB = 8 * 1024 * 1024;
// Decoding the fixture takes about a second, and Vitest waits five seconds by default
const TIMEOUT_MS = 30_000;

const decodeOrFail = async (text: string): Promise<SourceMapIndex> => {
  const result = await decodeSourceMap(text);
  if (!result.ok) {
    throw new Error(result.reason);
  }

  return result.map;
};

// Built once: every test only reads it
const LARGE_MAP = createLargeSourceMapText(EIGHT_MIB);

describe("decodeSourceMap on an 8 MiB map", { timeout: TIMEOUT_MS }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes it", async () => {
    const result = await decodeSourceMap(LARGE_MAP);

    expect(result.ok).toBe(true);
  });

  it("finds a generated position that leads back to its original line", async () => {
    const map = await decodeOrFail(LARGE_MAP);

    const generated = map.findGeneratedPosition("b.ts", 100);
    const original = map.findOriginalPosition(generated?.line ?? -1, generated?.column ?? -1);

    // A line without code gives the next line with code, so the original line may be past 100
    expect(map.findGeneratedPosition("b.ts", original?.line ?? -1)).toEqual(generated);
    expect(original?.line).toBeGreaterThanOrEqual(100);
  });

  it("yields to the event loop with setImmediate at least once per 16,000 characters", async () => {
    const yields = vi.spyOn(globalThis, "setImmediate");

    await decodeSourceMap(LARGE_MAP);

    expect(yields.mock.calls.length).toBeGreaterThan(EIGHT_MIB / 16_000);
  });
});
