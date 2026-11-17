import { beforeAll, describe, expect, it } from "vitest";

import { createSourceMapText, encodeMappings } from "../../../../test/source-maps/encode-mappings.js";
import { decodeSourceMap, type SourceMapIndex } from "../../source-map-decoder/index.js";
import type { MapSource, MapView, SearchView } from "../../source-maps/index.js";
import type { LocationContext } from "../collect-candidates.js";
import { findAddedTargets, findLocation, mayResolveTo, type LocatedEntry } from "../find-location.js";
import { ScriptRegistry, toSegments, type ScriptRecord } from "../script-registry.js";

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

const toSource = (path: string): MapSource => ({
  source: "../src/checkout.ts",
  path,
  segments: toSegments(path),
  isDependency: toSegments(path).includes("node_modules"),
});

/** What the context knows of the search of the bundles; an unlisted script is unsearched. */
interface Search {
  views?: Record<string, SearchView>;
  found?: Record<string, readonly string[]>;
  isSearching?: boolean;
  failure?: string;
}

/** A registry with the scripts and a view of each mapped one by URL; an unlisted mapped script is unread. */
const createContext = (
  scripts: ReadonlyArray<{ url: string; sourceMapURL?: string }>,
  views: Record<string, MapView>,
  search: Search = {},
): { records: Array<ScriptRecord | undefined>; context: LocationContext } => {
  const registry = new ScriptRegistry();
  const records = scripts.map((params) => registry.record(params));
  const byUrl = new Map(registry.listSearchable().map((script) => [script.url, script]));
  return {
    records,
    context: {
      findCandidates: (fileName) => registry.findCandidates(fileName),
      findMapped: (baseName) => registry.findMapped(baseName),
      listSearchable: () => registry.listSearchable(),
      viewMap: (script) => views[script.url] ?? { kind: "unread" },
      searchView: (script) => search.views?.[script.url] ?? "unsearched",
      findSearched: (fileName) =>
        Object.entries(search.found ?? {}).flatMap(([url, paths]) =>
          paths
            .filter((path) => path.endsWith(`/${fileName}`))
            .flatMap((path) => {
              const script = byUrl.get(url);
              return script === undefined ? [] : [{ script, source: toSource(path) }];
            }),
        ),
      isSearching: () => search.isSearching ?? false,
      searchFailure: () => search.failure,
    },
  };
};

const read = (path: string, withIndex = true): MapView => {
  const sources = [toSource(path)];
  return withIndex ? { kind: "read", sources, index } : { kind: "read", sources };
};

const MAPPED = { url: "file:///app/dist/checkout.js", sourceMapURL: "checkout.js.map" };
const BUNDLE = { url: "file:///app/dist/server.cjs", sourceMapURL: "server.cjs.map" };
const CHUNK = { url: "file:///app/.next/server/chunks/root.js", sourceMapURL: "root.js.map" };

describe("findLocation by name", () => {
  it("sets the breakpoint of a script without a map at the entry's line, 0-based", () => {
    const { context } = createContext([{ url: "file:///app/src/checkout.ts" }], {});

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "scripts",
      targets: [{ url: "file:///app/src/checkout.ts", position: { line: 7, column: 0 } }],
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
      kind: "scripts",
      targets: [{ url: MAPPED.url, position: { line: 6, column: 8 }, mapped: records[0] }],
    });
  });

  it("does not search the bundles when a candidate by name ends with every segment of the file", () => {
    const { context } = createContext([MAPPED, BUNDLE], { [MAPPED.url]: read("/app/src/checkout.ts") });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toMatchObject({ kind: "scripts" });
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

  it("keeps searching when no source of a read map ends in the entry's file name and the search finds nothing", () => {
    const { context } = createContext([MAPPED], { [MAPPED.url]: read("/app/src/checkout.tsx") });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [],
      searches: [],
    });
  });

  it("prefers a script without a map whose path ends with more segments of the file", () => {
    const { context } = createContext([MAPPED, { url: "file:///app/src/orders/checkout.ts" }], {
      [MAPPED.url]: read("/app/src/checkout.ts"),
    });

    expect(findLocation(entry(8), toSegments("src/orders/checkout.ts"), context)).toEqual({
      kind: "scripts",
      targets: [{ url: "file:///app/src/orders/checkout.ts", position: { line: 7, column: 0 } }],
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

  it("never resolves to a source under node_modules", () => {
    const { context } = createContext([MAPPED], { [MAPPED.url]: read("/app/node_modules/lib/src/checkout.ts") });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [],
      searches: [],
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
      isSearching: true,
    });
  });

  it("leaves a failed map out when another candidate matches", () => {
    const broken = { url: "file:///app/vendor/checkout.js", sourceMapURL: "checkout.js.map" };
    const { context, records } = createContext([broken, MAPPED], {
      [broken.url]: { kind: "failed", reason: "the source map is not valid JSON" },
      [MAPPED.url]: read("/app/src/checkout.ts"),
    });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "scripts",
      targets: [{ url: MAPPED.url, position: { line: 6, column: 8 }, mapped: records[1] }],
    });
  });

  it("stays pending for an entry without a file name", () => {
    const { context } = createContext([MAPPED], {});

    expect(findLocation(entry(8), toSegments("/"), context)).toEqual({ kind: "pending", reads: [] });
  });
});

describe("findLocation searching the bundles", () => {
  it("searches the maps of the other scripts when nothing by name ends with every segment of the file", () => {
    const { context, records } = createContext([BUNDLE, CHUNK], {});

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [],
      searches: [records[0], records[1]],
    });
  });

  it("does not search the maps of scripts under node_modules", () => {
    const dependency = { url: "file:///app/node_modules/next/dist/server.js", sourceMapURL: "server.js.map" };
    const { context } = createContext([dependency], {});

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [],
      searches: [],
    });
  });

  it("stays pending while a search read is running", () => {
    const { context } = createContext([BUNDLE], {}, { views: { [BUNDLE.url]: "searching" }, isSearching: true });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [],
      searches: [],
    });
  });

  it("reads by name the bundle a search found the file in", () => {
    const { context, records } = createContext(
      [BUNDLE],
      {},
      { views: { [BUNDLE.url]: "searched" }, found: { [BUNDLE.url]: ["/app/src/checkout.ts"] } },
    );

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "pending",
      reads: [records[0]],
    });
  });

  it("sets the breakpoint in the bundle once its map is read by name, with the winning path", () => {
    const { context, records } = createContext(
      [BUNDLE],
      { [BUNDLE.url]: read("/app/src/checkout.ts") },
      { views: { [BUNDLE.url]: "searched" }, found: { [BUNDLE.url]: ["/app/src/checkout.ts"] } },
    );

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "scripts",
      targets: [{ url: BUNDLE.url, position: { line: 6, column: 8 }, mapped: records[0] }],
      winningPath: "app/src/checkout.ts",
    });
  });

  it("sets the breakpoint in every chunk that holds the winning path", () => {
    const view = read("/app/src/checkout.ts");
    const { context, records } = createContext(
      [BUNDLE, CHUNK],
      { [BUNDLE.url]: view, [CHUNK.url]: view },
      {
        views: { [BUNDLE.url]: "searched", [CHUNK.url]: "searched" },
        found: { [BUNDLE.url]: ["/app/src/checkout.ts"], [CHUNK.url]: ["/app/src/checkout.ts"] },
      },
    );

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toMatchObject({
      kind: "scripts",
      targets: [
        { url: BUNDLE.url, mapped: records[0] },
        { url: CHUNK.url, mapped: records[1] },
      ],
    });
  });

  it("sets one target when the map of a bundle lists the same path twice", () => {
    const { context, records } = createContext(
      [BUNDLE],
      { [BUNDLE.url]: read("/app/src/checkout.ts") },
      {
        views: { [BUNDLE.url]: "searched" },
        found: { [BUNDLE.url]: ["/app/src/checkout.ts", "/app/src/checkout.ts"] },
      },
    );

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "scripts",
      targets: [{ url: BUNDLE.url, position: { line: 6, column: 8 }, mapped: records[0] }],
      winningPath: "app/src/checkout.ts",
    });
  });

  it("gives error when two different sources of one bundle match as well", () => {
    const { context } = createContext(
      [BUNDLE],
      {},
      {
        views: { [BUNDLE.url]: "searched" },
        found: { [BUNDLE.url]: ["/app/orders/checkout.ts", "/app/billing/checkout.ts"] },
      },
    );

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "error",
      message: "file matches several files",
    });
  });

  it("does not count a search candidate of a script also matched by name twice", () => {
    const { context, records } = createContext(
      [MAPPED],
      { [MAPPED.url]: read("/app/src/checkout.ts") },
      { views: { [MAPPED.url]: "searched" }, found: { [MAPPED.url]: ["/app/src/checkout.ts"] } },
    );

    expect(findLocation(entry(8), toSegments("lib/src/checkout.ts"), context)).toEqual({
      kind: "scripts",
      targets: [{ url: MAPPED.url, position: { line: 6, column: 8 }, mapped: records[0] }],
      winningPath: "app/src/checkout.ts",
    });
  });

  it("gives the reason of a map over a limit, to be retried, when the search finds nothing", () => {
    const failure = "the source map is larger than 8 MiB";
    const { context } = createContext([BUNDLE], {}, { views: { [BUNDLE.url]: "searched" }, failure });

    expect(findLocation(entry(8), toSegments("src/checkout.ts"), context)).toEqual({
      kind: "error",
      message: failure,
      isRetryable: true,
      isSearching: true,
    });
  });
});

describe("findAddedTargets", () => {
  const LATER = { url: "file:///app/.next/server/chunks/later.js", sourceMapURL: "later.js.map" };
  const found = { [CHUNK.url]: ["/app/src/checkout.ts"], [LATER.url]: ["/app/src/checkout.ts"] };
  const placement = { winningPath: "app/src/checkout.ts", urls: new Set([CHUNK.url]) };

  it("gives a chunk loaded later whose map holds the winning path", () => {
    const { context, records } = createContext(
      [CHUNK, LATER],
      { [LATER.url]: read("/app/src/checkout.ts") },
      { found },
    );

    expect(findAddedTargets(entry(8), placement, context)).toEqual({
      targets: [{ url: LATER.url, position: { line: 6, column: 8 }, mapped: records[1] }],
      reads: [],
      withoutCode: [],
    });
  });

  it("lists a chunk whose map has no code at the line, so it is not read again", () => {
    const { context } = createContext([CHUNK, LATER], { [LATER.url]: read("/app/src/checkout.ts") }, { found });

    expect(findAddedTargets(entry(11), placement, context)).toEqual({
      targets: [],
      reads: [],
      withoutCode: [LATER.url],
    });
  });

  it("reads by name the map of such a chunk first", () => {
    const { context, records } = createContext([CHUNK, LATER], {}, { found });

    expect(findAddedTargets(entry(8), placement, context)).toEqual({
      targets: [],
      reads: [records[1]],
      withoutCode: [],
    });
  });

  it("leaves out a chunk whose source has another path, and one whose map cannot be read by name", () => {
    const failed: MapView = { kind: "failed", reason: "the source map is not valid JSON" };
    const other = { [CHUNK.url]: ["/app/src/checkout.ts"], [LATER.url]: ["/app/lib/checkout.ts"] };
    const { context } = createContext(
      [CHUNK, LATER, BUNDLE],
      { [BUNDLE.url]: failed },
      {
        found: { ...other, [BUNDLE.url]: ["/app/src/checkout.ts"] },
      },
    );

    expect(findAddedTargets(entry(8), placement, context)).toEqual({ targets: [], reads: [], withoutCode: [] });
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
