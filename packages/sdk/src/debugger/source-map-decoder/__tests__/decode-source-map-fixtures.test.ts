import { readFileSync } from "node:fs";
import { SourceMap, type SourceMapPayload } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { decodeSourceMap } from "../index.js";

// The maps were made from test/source-maps/fixtures/greeter.ts, run from its folder, with
//   tsc --ignoreConfig greeter.ts --sourceMap --target es2022 --module esnext
//   esbuild greeter.ts --sourcemap --format=esm --target=es2022
const FIXTURES = path.resolve(import.meta.dirname, "../../../../test/source-maps/fixtures");
const readFixture = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

const decodeFixture = async (name: string) => {
  const result = await decodeSourceMap(readFixture(name));
  if (!result.ok) {
    throw new Error(result.reason);
  }

  return result.map;
};

interface ReferenceEntry {
  readonly generatedLine?: number;
  readonly originalLine?: number;
  readonly originalColumn?: number;
}

// Node returns the nearest entry at or before the position, which can lie on an earlier line, or an empty object
const entryAt = (reference: SourceMap, line: number, column: number): ReferenceEntry =>
  reference.findEntry(line, column);

// Every generated position of the fixtures' scripts, 20 lines of up to 80 columns
const GENERATED_POSITIONS = Array.from({ length: 20 * 80 }, (_, index) => ({
  line: Math.floor(index / 80),
  column: index % 80,
}));

interface FixtureCase {
  readonly tool: string;
  readonly file: string;
  // Original line (0-based) of greeter.ts → [generated line, generated column]
  readonly expected: ReadonlyArray<readonly [number, readonly [number, number]]>;
  // An original line without code, and the position of the next line that has code
  readonly lineWithoutCode: readonly [number, readonly [number, number]];
}

const CASES: FixtureCase[] = [
  {
    tool: "tsc",
    file: "greeter.tsc.js.map",
    expected: [
      [6, [1, 0]], // export class Greeter
      [9, [6, 4]], // greet(times)
      [10, [7, 8]], // let text = ""
      [12, [9, 12]], // text += ...
      [15, [11, 8]], // return { ... }
      [19, [14, 0]], // export const greetTwice
    ],
    lineWithoutCode: [2, [1, 0]],
  },
  {
    tool: "esbuild",
    file: "greeter.esbuild.js.map",
    expected: [
      [6, [0, 0]], // class Greeter
      [9, [5, 2]], // greet(times)
      [10, [6, 0]], // let text = ""
      [12, [8, 0]], // text += ...
      [15, [10, 0]], // return { ... }
      [19, [13, 0]], // const greetTwice
    ],
    lineWithoutCode: [2, [0, 0]],
  },
];

describe.each(CASES)("a map made by $tool", ({ file, expected, lineWithoutCode }) => {
  it("lists the original file", async () => {
    const map = await decodeFixture(file);

    expect(map.sources).toEqual(["greeter.ts"]);
  });

  it.each(expected)("maps original line %d to its generated position", async (line, [generatedLine, column]) => {
    const map = await decodeFixture(file);

    expect(map.findGeneratedPosition("greeter.ts", line)).toEqual({ line: generatedLine, column });
  });

  it("maps a line without code to the next line that has code", async () => {
    const map = await decodeFixture(file);
    const [line, [generatedLine, column]] = lineWithoutCode;

    expect(map.findGeneratedPosition("greeter.ts", line)).toEqual({ line: generatedLine, column });
  });

  it("returns undefined for a line after the last one with code", async () => {
    const map = await decodeFixture(file);

    expect(map.findGeneratedPosition("greeter.ts", 20)).toBeUndefined();
  });

  it.each(expected)("maps the generated position of original line %d back to that line", async (line, position) => {
    const map = await decodeFixture(file);
    const [generatedLine, column] = position;

    expect(map.findOriginalPosition(generatedLine, column)).toMatchObject({ source: "greeter.ts", line });
  });

  it("agrees with Node's own source map reader on every generated position of the same line", async () => {
    const map = await decodeFixture(file);
    // The fixture is a source map file
    const reference = new SourceMap(JSON.parse(readFixture(file)) as SourceMapPayload);
    const comparable = GENERATED_POSITIONS.filter(
      ({ line, column }) => entryAt(reference, line, column).generatedLine === line,
    );

    const mismatches = comparable
      .map(({ line, column }) => ({
        line,
        column,
        ours: map.findOriginalPosition(line, column),
        node: entryAt(reference, line, column),
      }))
      .filter(({ ours, node }) => ours?.line !== node.originalLine || ours?.column !== node.originalColumn);

    expect(comparable.length).toBeGreaterThan(100);
    expect(mismatches).toEqual([]);
  });
});
