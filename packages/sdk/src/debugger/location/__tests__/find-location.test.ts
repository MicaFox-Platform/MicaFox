import { beforeAll, describe, expect, it } from "vitest";

import { createSourceMapText, encodeMappings } from "../../../../test/source-maps/encode-mappings.js";
import { decodeSourceMap, type SourceMapIndex } from "../../source-map-decoder/index.js";
import type { MapView } from "../../source-maps/index.js";
import { findLocation, mayResolveTo, type LocatedEntry } from "../find-location.js";
import { ScriptRegistry, toSegments, type MappedRecord, type ScriptRecord } from "../script-registry.js";

// checkout.ts line 7 (0-based) maps to generated line 6, column 8; nothing after line 9 has code
let index: SourceMapIndex;

beforeAll(async () => {
  const decoded = await decodeSourceMap(
    createSourceMapText(
      ["../src/checkout.ts"],
      encodeMappings([
        [],
        [],
        [],
        [],
        [],
        [],
        [{ column: 8, source: 0, line: 7, originalColumn: 4 }],
        [{ column: 4, source: 0, line: 9, originalColumn: 2 }],
      ]),
    ),
  );
  if (!decoded.ok) {
    throw new Error(decoded.reason);
  }

  index = decoded.map;
});

const entry = (line: number): LocatedEntry => ({ line });

/** A registry with the scripts and a view of each mapped one by URL; an unlisted mapped script is unread. */
const createContext = (
  scripts: ReadonlyArray<{ url: string; sourceMapURL?: string }>,
  views: Record<string, MapView>,
) => {
  const registry = new ScriptRegistry();
  const records = scripts.map((params) => registry.record(params));
  return {
    records,
    context: {
      findCandidates: (fileName: string) => registry.findCandidates(fileName),
      findMapped: (baseName: string) => registry.findMapped(baseName),
      viewMap: (script: MappedRecord): MapView => views[script.url] ?? { kind: "unread" },
    },
  };
};

const read = (path: string, withIndex = true): MapView => {
  const sources = [{ source: "../src/checkout.ts", path, segments: toSegments(path) }];
  return withIndex ? { kind: "read", sources, index } : { kind: "read", sources };
};

const MAPPED = { url: "file:///app/dist/checkout.js", sourceMapURL: "checkout.js.map" };

describe("findLocation", () => {
  it("sets the breakpoint of a script without a map at the entry's line, 0-based", () => {
    const { context } = createContext([{ url: "file:///app/src/checkout.ts" }], {});

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "script",
      url: "file:///app/src/checkout.ts",
      position: { line: 7, column: 0 },
    });
  });

  it("waits for the maps of the scripts with the entry's base name that are not read", () => {
    const { context, records } = createContext(
      [MAPPED, { url: "file:///app/dist/invoice.js", sourceMapURL: "invoice.js.map" }],
      {},
    );

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [records[0]],
    });
  });

  it("keeps waiting while a map is being read", () => {
    const { context, records } = createContext([MAPPED], { [MAPPED.url]: { kind: "reading" } });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [records[0]],
    });
  });

  it("sets the breakpoint at the generated position of a source of a read map", () => {
    const { context, records } = createContext([MAPPED], { [MAPPED.url]: read("/app/src/checkout.ts") });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "script",
      url: MAPPED.url,
      position: { line: 6, column: 8 },
      mapped: records[0],
    });
  });

  it("gives error when no line from the entry's on has code in the map", () => {
    const { context } = createContext([MAPPED], { [MAPPED.url]: read("/app/src/checkout.ts") });

    expect(findLocation(entry(11), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "error",
      message: "no code at or after line 11",
    });
  });

  it("reads a map again when the winning source's index was dropped", () => {
    const { context, records } = createContext([MAPPED], { [MAPPED.url]: read("/app/src/checkout.ts", false) });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [records[0]],
    });
  });

  it("stays pending when no source of a read map ends in the entry's file name", () => {
    const { context } = createContext([MAPPED], { [MAPPED.url]: read("/app/src/checkout.tsx") });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({ kind: "pending", reads: [] });
  });

  it("prefers a script without a map whose path ends with more segments of the file", () => {
    const { context } = createContext([MAPPED, { url: "file:///app/src/orders/checkout.ts" }], {
      [MAPPED.url]: read("/app/src/checkout.ts"),
    });

    expect(findLocation(entry(8), toSegments("src/orders/checkout.ts"), context)).toEqual({
      kind: "script",
      url: "file:///app/src/orders/checkout.ts",
      position: { line: 7, column: 0 },
    });
  });

  it("gives error when a source of a map and a script without one tie", () => {
    const { context } = createContext([MAPPED, { url: "file:///other/src/checkout.ts" }], {
      [MAPPED.url]: read("/app/src/checkout.ts"),
    });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "error",
      message: "file matches several files",
    });
  });

  it("gives the reason of a failed map, to be retried, when nothing else matches", () => {
    const { context } = createContext([MAPPED], {
      [MAPPED.url]: { kind: "failed", reason: "the source map is not valid JSON" },
    });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "error",
      message: "the source map is not valid JSON",
      isRetryable: true,
    });
  });

  it("leaves a failed map out when another candidate matches", () => {
    const broken = { url: "file:///app/node_modules/lib/checkout.js", sourceMapURL: "checkout.js.map" };
    const { context, records } = createContext([broken, MAPPED], {
      [broken.url]: { kind: "failed", reason: "the source map is not valid JSON" },
      [MAPPED.url]: read("/app/src/checkout.ts"),
    });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "script",
      url: MAPPED.url,
      position: { line: 6, column: 8 },
      mapped: records[1],
    });
  });

  it("stays pending for an entry without a file name", () => {
    const { context } = createContext([MAPPED], {});

    expect(findLocation(entry(8), toSegments("/"), context)).toEqual({ kind: "pending", reads: [] });
  });
});

describe("mayResolveTo", () => {
  const record = (url: string, sourceMapUrl?: string): ScriptRecord =>
    sourceMapUrl === undefined ? { url, segments: toSegments(url) } : { url, segments: toSegments(url), sourceMapUrl };

  it.each([
    ["checkout.ts", record("/app/checkout.ts"), true],
    ["checkout.ts", record("/app/checkout.js"), false],
    ["checkout.ts", record("/app/checkout.js", "checkout.js.map"), true],
    ["checkout.ts", record("/app/invoice.js", "invoice.js.map"), false],
    [undefined, record("/app/checkout.js"), false],
  ])("for %s and %o gives %s", (fileName, script, expected) => {
    expect(mayResolveTo(fileName, script)).toBe(expected);
  });
});
