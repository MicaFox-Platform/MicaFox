import { afterEach, describe, expect, it, vi } from "vitest";

import { createSourceMapText, encodeVlq } from "../../../../test/source-maps/encode-mappings.js";
import { decodeSourceMap } from "../index.js";

const MAX_LENGTH = 8 * 1024 * 1024;
// Decoding 1,500,000 segments takes about a second, more under coverage; Vitest waits five seconds by default
const TIMEOUT_MS = 30_000;

describe("decodeSourceMap errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an index map", async () => {
    const text = JSON.stringify({ version: 3, sections: [] });

    const result = await decodeSourceMap(text);

    expect(result).toEqual({ ok: false, reason: "index maps are not supported" });
  });

  it("rejects an input over 8 MiB without parsing it", async () => {
    // Not JSON: parsing would give another reason
    const result = await decodeSourceMap("x".repeat(MAX_LENGTH + 1));

    expect(result).toEqual({ ok: false, reason: "the source map is larger than 8 MiB" });
  });

  it("accepts an input of exactly 8 MiB", async () => {
    const padding = " ".repeat(MAX_LENGTH - createSourceMapText(["a.ts"], "AAAA").length);

    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAAA") + padding);

    expect(result.ok).toBe(true);
  });

  it("rejects JSON nested deeper than a map needs", async () => {
    const result = await decodeSourceMap("[".repeat(1_000_000));

    expect(result).toEqual({ ok: false, reason: "the source map is nested too deeply" });
  });

  it("decodes a map with a null source and maps its segments to nothing", async () => {
    const result = await decodeSourceMap(JSON.stringify({ version: 3, sources: [null], mappings: "AAAA" }));

    expect(result.ok && result.map.findOriginalPosition(0, 0)).toBeUndefined();
  });

  it("rejects text that is not JSON", async () => {
    const result = await decodeSourceMap("{ not json");

    expect(result).toEqual({ ok: false, reason: "the source map is not valid JSON" });
  });

  it.each(["null", "[]", '"text"', "3"])("rejects the JSON value %s", async (text) => {
    const result = await decodeSourceMap(text);

    expect(result).toEqual({ ok: false, reason: "the source map is not an object" });
  });

  it.each([2, 4, "3", undefined])("rejects the version %s", async (version) => {
    const text = JSON.stringify({ version, sources: [], mappings: "" });

    const result = await decodeSourceMap(text);

    expect(result).toEqual({ ok: false, reason: "only source map version 3 is supported" });
  });

  it.each([
    [{ version: 3, mappings: "" }, "sources must be a list of strings"],
    [{ version: 3, sources: "a.ts", mappings: "" }, "sources must be a list of strings"],
    [{ version: 3, sources: ["a.ts", 1], mappings: "" }, "sources must be a list of strings"],
    [{ version: 3, sources: [] }, "mappings must be a string"],
    [{ version: 3, sources: [], mappings: 5 }, "mappings must be a string"],
    [{ version: 3, sources: [], sourceRoot: 5, mappings: "" }, "sourceRoot must be a string"],
  ])("rejects the map %j", async (map, reason) => {
    const result = await decodeSourceMap(JSON.stringify(map));

    expect(result).toEqual({ ok: false, reason });
  });

  it("rejects a bad VLQ character in the mappings", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAA$"));

    expect(result).toEqual({ ok: false, reason: "mappings hold a bad VLQ character" });
  });

  it("rejects mappings that end inside a value", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAAg"));

    expect(result).toEqual({ ok: false, reason: "mappings end inside a VLQ value" });
  });

  it("rejects a source index past the end of sources", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "ACAA"));

    expect(result).toEqual({ ok: false, reason: "a source index is out of range" });
  });

  it("rejects a negative source index", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "ADAA"));

    expect(result).toEqual({ ok: false, reason: "a source index is out of range" });
  });

  it("rejects a segment with two fields", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AA"));

    expect(result).toEqual({ ok: false, reason: "a segment has two or three fields" });
  });

  it("rejects a segment with three fields", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAA"));

    expect(result).toEqual({ ok: false, reason: "a segment has two or three fields" });
  });

  it("rejects a segment with more than five fields", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAAAAA"));

    expect(result).toEqual({ ok: false, reason: "a segment has too many fields" });
  });

  it("rejects a negative original line", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AADA"));

    expect(result).toEqual({ ok: false, reason: "a mapping position is out of range" });
  });

  it("rejects a negative original column", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAAD"));

    expect(result).toEqual({ ok: false, reason: "a mapping position is out of range" });
  });

  it("rejects an original line past what the lookups can hold", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], `AA${encodeVlq(2 ** 31)}A`));

    expect(result).toEqual({ ok: false, reason: "a mapping position is out of range" });
  });

  it("rejects a generated column that goes backwards inside a line", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "KAAA,FAAA"));

    expect(result).toEqual({ ok: false, reason: "mappings are not in generated order" });
  });

  it("rejects a generated column past what the lookups can hold", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], `${encodeVlq(2 ** 31)}AAA`));

    expect(result).toEqual({ ok: false, reason: "a mapping position is out of range" });
  });

  it("rejects a map of more than 1,500,000 segments", { timeout: TIMEOUT_MS }, async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "A,".repeat(1_500_001)));

    expect(result).toEqual({ ok: false, reason: "the source map has more than 1,500,000 segments" });
  });

  it("accepts a map of exactly 1,500,000 segments", { timeout: TIMEOUT_MS }, async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "A,".repeat(1_500_000)));

    expect(result.ok).toBe(true);
  });

  it("does not throw when the mappings are not a string of segments at all", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "🙂"));

    expect(result).toEqual({ ok: false, reason: "mappings hold a bad VLQ character" });
  });

  it("gives a fixed reason for a failure that is not a source map error", async () => {
    vi.spyOn(globalThis, "setImmediate").mockImplementation(() => {
      throw new RangeError("out of memory for /secret/path");
    });

    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAAA"));

    expect(result).toEqual({ ok: false, reason: "the source map cannot be decoded" });
  });
});
