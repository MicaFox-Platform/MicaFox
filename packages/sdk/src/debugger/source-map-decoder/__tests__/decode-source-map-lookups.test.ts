import { describe, expect, it } from "vitest";

import { createSourceMapText, encodeMappings, type Segment } from "../../../../test/source-maps/encode-mappings.js";
import { naiveGeneratedPosition, naiveOriginalPosition } from "../../../../test/source-maps/naive-lookups.js";
import { decodeSourceMap, type SourceMapIndex } from "../index.js";

const decodeOrFail = async (sources: readonly string[], lines: ReadonlyArray<readonly Segment[]>) => {
  const result = await decodeSourceMap(createSourceMapText(sources, encodeMappings(lines)));
  if (!result.ok) {
    throw new Error(result.reason);
  }

  return result.map;
};

// Original lines 0, 1 and 4 have code; lines 2, 3 and 5 do not
const SPARSE_LINES: Segment[][] = [
  [{ column: 0, source: 0, line: 1, originalColumn: 0 }],
  [
    { column: 2, source: 0, line: 0, originalColumn: 4 },
    { column: 8, source: 0, line: 4, originalColumn: 2 },
  ],
  [],
  [{ column: 0, source: 0, line: 1, originalColumn: 6 }],
];

describe("SourceMapIndex.findGeneratedPosition", () => {
  it("returns the generated position of a line that has code", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findGeneratedPosition("a.ts", 4)).toEqual({ line: 1, column: 8 });
  });

  it("returns the first generated position when a line has several", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findGeneratedPosition("a.ts", 1)).toEqual({ line: 0, column: 0 });
  });

  it("returns the position of the next line that has code when the line has none", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findGeneratedPosition("a.ts", 2)).toEqual({ line: 1, column: 8 });
  });

  it("returns undefined for a line after the last one with code", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findGeneratedPosition("a.ts", 5)).toBeUndefined();
  });

  it("returns undefined for a source the map does not list", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findGeneratedPosition("b.ts", 0)).toBeUndefined();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "returns undefined for the line %d",
    async (line) => {
      const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

      expect(map.findGeneratedPosition("a.ts", line)).toBeUndefined();
    },
  );

  it("does not run into the lines of the next source", async () => {
    const map = await decodeOrFail(
      ["a.ts", "b.ts"],
      [[{ column: 0, source: 0, line: 0, originalColumn: 0 }], [{ column: 0, source: 1, line: 9, originalColumn: 0 }]],
    );

    expect(map.findGeneratedPosition("a.ts", 1)).toBeUndefined();
  });

  it("keeps the sources apart when they use the same original line", async () => {
    const map = await decodeOrFail(
      ["a.ts", "b.ts"],
      [[{ column: 1, source: 0, line: 3, originalColumn: 0 }], [{ column: 5, source: 1, line: 3, originalColumn: 0 }]],
    );

    expect([map.findGeneratedPosition("a.ts", 3), map.findGeneratedPosition("b.ts", 3)]).toEqual([
      { line: 0, column: 1 },
      { line: 1, column: 5 },
    ]);
  });

  it("finds a file listed twice under both of its entries", async () => {
    const map = await decodeOrFail(
      ["a.ts", "b.ts", "a.ts"],
      [[{ column: 0, source: 0, line: 0, originalColumn: 0 }], [{ column: 0, source: 2, line: 7, originalColumn: 0 }]],
    );

    expect(map.findGeneratedPosition("a.ts", 6)).toEqual({ line: 1, column: 0 });
  });

  it("ignores a segment that maps to no source", async () => {
    const map = await decodeOrFail(["a.ts"], [[{ column: 0 }, { column: 4, source: 0, line: 2, originalColumn: 0 }]]);

    expect(map.findGeneratedPosition("a.ts", 0)).toEqual({ line: 0, column: 4 });
  });

  it("returns undefined for an empty map", async () => {
    const map = await decodeOrFail(["a.ts"], []);

    expect(map.findGeneratedPosition("a.ts", 0)).toBeUndefined();
  });
});

describe("SourceMapIndex.findOriginalPosition", () => {
  it("returns the segment that starts at the column", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findOriginalPosition(1, 8)).toEqual({ source: "a.ts", line: 4, column: 2 });
  });

  it("returns the nearest segment before the column", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findOriginalPosition(1, 7)).toEqual({ source: "a.ts", line: 0, column: 4 });
  });

  it("returns the last segment of the line for a column past it", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findOriginalPosition(1, 500)).toEqual({ source: "a.ts", line: 4, column: 2 });
  });

  it("returns undefined for a column before the first segment of the line", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findOriginalPosition(1, 1)).toBeUndefined();
  });

  it("does not take a segment from an earlier line", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findOriginalPosition(2, 5)).toBeUndefined();
  });

  it("returns undefined for a line after the last one", async () => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findOriginalPosition(40, 0)).toBeUndefined();
  });

  it("names the source of the segment", async () => {
    const map = await decodeOrFail(
      ["a.ts", "b.ts"],
      [
        [
          { column: 0, source: 0, line: 0, originalColumn: 0 },
          { column: 3, source: 1, line: 8, originalColumn: 1 },
        ],
      ],
    );

    expect(map.findOriginalPosition(0, 3)).toEqual({ source: "b.ts", line: 8, column: 1 });
  });

  it("names a file listed twice by its name from either entry", async () => {
    const map = await decodeOrFail(["a.ts", "b.ts", "a.ts"], [[{ column: 0, source: 2, line: 4, originalColumn: 1 }]]);

    expect(map.findOriginalPosition(0, 0)).toEqual({ source: "a.ts", line: 4, column: 1 });
  });

  it("returns undefined where a segment without a source ends the previous one", async () => {
    const map = await decodeOrFail(["a.ts"], [[{ column: 0, source: 0, line: 0, originalColumn: 0 }, { column: 5 }]]);

    expect([map.findOriginalPosition(0, 4)?.line, map.findOriginalPosition(0, 6)]).toEqual([0, undefined]);
  });

  it.each([
    [-1, 0],
    [0, -1],
    [0.5, 0],
    [0, Number.NaN],
  ])("returns undefined for the position (%d, %d)", async (line, column) => {
    const map = await decodeOrFail(["a.ts"], SPARSE_LINES);

    expect(map.findOriginalPosition(line, column)).toBeUndefined();
  });
});

describe("SourceMapIndex fields", () => {
  it("carries sources and sourceRoot as written", async () => {
    const result = await decodeSourceMap(createSourceMapText(["a.ts", "b/c.ts"], "AAAA", "../src/"));

    expect(result.ok && [result.map.sources, result.map.sourceRoot]).toEqual([["a.ts", "b/c.ts"], "../src/"]);
  });

  it("uses an empty sourceRoot when the map has none", async () => {
    const map = await decodeOrFail(["a.ts"], []);

    expect(map.sourceRoot).toBe("");
  });
});

// A fixed seed makes the failure of a random map reproducible
const createRandomLines = (): Segment[][] => {
  let seed = 12_345;
  const next = (limit: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  };

  return Array.from({ length: 60 }, () => {
    let column = 0;
    return Array.from({ length: next(8) }, () => {
      column += next(6);
      return next(10) === 0 ? { column } : { column, source: next(3), line: next(25), originalColumn: next(30) };
    });
  });
};

describe("SourceMapIndex against a scan of every segment", () => {
  const SOURCES = ["a.ts", "b.ts", "c.ts"];
  const lines = createRandomLines();
  const positions = Array.from({ length: 62 * 45 }, (_, index) => ({
    line: Math.floor(index / 45),
    column: index % 45,
  }));
  const originalLines = SOURCES.flatMap((_, source) =>
    Array.from({ length: 28 }, (_entry, line) => ({ source, line })),
  );

  const mismatches = async (): Promise<unknown[]> => {
    const map: SourceMapIndex = await decodeOrFail(SOURCES, lines);
    const generated = originalLines
      .filter(
        ({ source, line }) =>
          JSON.stringify(map.findGeneratedPosition(SOURCES[source] ?? "", line)) !==
          JSON.stringify(naiveGeneratedPosition(lines, source, line)),
      )
      .map((position) => ({ kind: "generated", ...position }));
    const original = positions
      .filter(
        (position) =>
          JSON.stringify(map.findOriginalPosition(position.line, position.column)) !==
          JSON.stringify(naiveOriginalPosition(lines, SOURCES, position)),
      )
      .map((position) => ({ kind: "original", ...position }));

    return [...generated, ...original];
  };

  it("finds the same positions as a scan on a map of random segments", async () => {
    expect(await mismatches()).toEqual([]);
  });
});
