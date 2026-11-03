import { describe, expect, it } from "vitest";

import { drain } from "../../../../test/source-maps/drain.js";
import { NO_SOURCE } from "../decode-mappings.js";
import { parseSourceMap } from "../parse-source-map.js";
import { WorkBudget } from "../sliced-work.js";

const parse = (text: string) => drain(parseSourceMap(text, new WorkBudget(1000))).value;

describe("parseSourceMap", () => {
  it("rejects nesting deeper than any map needs", () => {
    const text = `{"version":3,"sources":[],"mappings":"","x":${"[".repeat(8)}${"]".repeat(8)}}`;

    expect(() => parse(text)).toThrow("the source map is nested too deeply");
  });

  it("accepts eight levels of nesting", () => {
    const text = `{"version":3,"sources":[],"mappings":"","x":${"[".repeat(7)}${"]".repeat(7)}}`;

    expect(parse(text).mappings).toBe("");
  });

  it("rejects more values than any map needs", () => {
    const text = `{"version":3,"sources":[],"mappings":"","names":[${"0,".repeat(50_000)}0]}`;

    expect(() => parse(text)).toThrow("the source map has more than 50,000 JSON values");
  });

  it("does not count brackets, commas and escaped quotes inside strings", () => {
    const text = JSON.stringify({ version: 3, sources: ['a\\"[[[[[[[[,,,.ts'], mappings: "A,".repeat(60_000) });

    expect(parse(text).sources).toEqual(['a\\"[[[[[[[[,,,.ts']);
  });

  it("gives a null source no id that a name finds", () => {
    const map = parse(JSON.stringify({ version: 3, sources: [null, "a.ts"], mappings: "" }));

    expect([map.sources, [...map.sourceIds], [...map.sourceIdsByName]]).toEqual([
      ["", "a.ts"],
      [NO_SOURCE, 1],
      [["a.ts", 1]],
    ]);
  });

  it("gives a file listed twice the id of its first entry", () => {
    const map = parse(JSON.stringify({ version: 3, sources: ["a.ts", "b.ts", "a.ts"], mappings: "" }));

    expect([...map.sourceIds]).toEqual([0, 1, 0]);
  });

  it("yields once per slice while it checks the shape of the text", () => {
    const text = JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "A".repeat(1_000_000) });

    const { yields } = drain(parseSourceMap(text, new WorkBudget(1000)));

    // A character of the scan is worth an eighth of a unit
    expect(yields).toBeGreaterThanOrEqual(120);
  });
});
