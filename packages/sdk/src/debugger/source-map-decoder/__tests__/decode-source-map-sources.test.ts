import { describe, expect, it } from "vitest";

import { createSourceMapText } from "../../../../test/source-maps/encode-mappings.js";
import { decodeSourceMap, readMapSources } from "../index.js";

const MAX_LENGTH = 8 * 1024 * 1024;
// Counting 1,500,000 segments takes a moment under coverage; Vitest waits five seconds by default
const TIMEOUT_MS = 30_000;

describe("readMapSources", () => {
  it("returns the sourceRoot and the sources of a bundle's map, with null as an empty string", async () => {
    const text = JSON.stringify({ version: 3, sourceRoot: "/app", sources: ["a.ts", null, "b.ts"], mappings: "AAAA" });

    const result = await readMapSources(text);

    expect(result).toEqual({ ok: true, map: { sourceRoot: "/app", sources: ["a.ts", "", "b.ts"] } });
  });

  it("does not decode the segments, so a mapping a lookup would reject still gives the sources", async () => {
    const result = await readMapSources(createSourceMapText(["a.ts"], "KAAA,FAAA"));

    expect(result).toEqual({ ok: true, map: { sourceRoot: "", sources: ["a.ts"] } });
  });

  it("rejects an index map as invalid, not over a limit", async () => {
    const result = await readMapSources(JSON.stringify({ version: 3, sections: [] }));

    expect(result).toEqual({ ok: false, reason: "index maps are not supported", isOverLimit: false });
  });

  it("rejects an input over 8 MiB as over the limit", async () => {
    const result = await readMapSources("x".repeat(MAX_LENGTH + 1));

    expect(result).toEqual({ ok: false, reason: "the source map is larger than 8 MiB", isOverLimit: true });
  });

  it("rejects more than 50,000 JSON values as over the limit", async () => {
    const text = `{"version":3,"sources":[],"mappings":"","names":[${"0,".repeat(50_000)}0]}`;

    const result = await readMapSources(text);

    expect(result).toEqual({ ok: false, reason: "the source map has more than 50,000 JSON values", isOverLimit: true });
  });

  it("rejects more than 1,500,000 segments as over the limit", { timeout: TIMEOUT_MS }, async () => {
    const result = await readMapSources(createSourceMapText(["a.ts"], "A,".repeat(1_500_001)));

    expect(result).toEqual({
      ok: false,
      reason: "the source map has more than 1,500,000 segments",
      isOverLimit: true,
    });
  });

  it("rejects text that is not JSON as invalid", async () => {
    const result = await readMapSources("{ not json");

    expect(result).toEqual({ ok: false, reason: "the source map is not valid JSON", isOverLimit: false });
  });
});

describe("SourceMapIndex.segmentCount", () => {
  it("counts every segment of the map, mapped or not", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts"], "AAAA,C;AACA,E"));

    expect(result.ok && result.map.segmentCount).toBe(4);
  });
});
