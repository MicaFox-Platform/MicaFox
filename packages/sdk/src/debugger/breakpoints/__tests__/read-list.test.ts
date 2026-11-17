import { describe, expect, it } from "vitest";

import { readBreakpointList } from "../read-list.js";

const read = (...breakpoints: unknown[]) =>
  readBreakpointList({ version: 1, module: "debugger", type: "breakpoints", breakpoints });

const checkout = { id: "bp-1", file: "src/orders/checkout.ts", line: 42, expiresInMs: 3_600_000 };

describe("readBreakpointList", () => {
  it("reads a valid entry with its limits", () => {
    const list = read({ ...checkout, limits: { maxDepth: 2, maxItems: 5, maxStringLength: 64, other: "x" } });

    expect(list?.entries).toEqual([
      { kind: "valid", ...checkout, limits: { maxDepth: 2, maxItems: 5, maxStringLength: 64 } },
    ]);
  });

  it("reads an entry without limits", () => {
    expect(read(checkout)?.entries).toEqual([{ kind: "valid", ...checkout }]);
  });

  it.each([
    ["0, which expires the entry at once", 0, 0],
    ["a time under 24 h as it is", 86_399_999, 86_399_999],
    ["exactly 24 h as it is", 86_400_000, 86_400_000],
    ["a time over 24 h lowered to 24 h", 86_400_001, 86_400_000],
    ["a huge time lowered to 24 h", 2 ** 60, 86_400_000],
  ])("reads %s", (_name, expiresInMs, expected) => {
    expect(read({ ...checkout, expiresInMs })?.entries).toEqual([
      { kind: "valid", ...checkout, expiresInMs: expected },
    ]);
  });

  it.each([
    ["a missing expiresInMs", undefined],
    ["a null expiresInMs", null],
    ["an expiresInMs that is a string", "60000"],
    ["a fractional expiresInMs", 1.5],
    ["a negative expiresInMs", -1],
    ["an infinite expiresInMs", Number.POSITIVE_INFINITY],
    ["an expiresInMs that is not a number", Number.NaN],
  ])("gives %s an error", (_name, expiresInMs) => {
    const list = read({ ...checkout, expiresInMs });

    expect(list?.entries).toEqual([
      { kind: "invalid", id: "bp-1", message: "expiresInMs must be an integer of at least 0" },
    ]);
  });

  it("returns nothing when breakpoints is not an array", () => {
    expect([
      readBreakpointList({ module: "debugger", type: "breakpoints" }),
      readBreakpointList({ breakpoints: "bp-1" }),
      readBreakpointList(null),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it("reads an empty list", () => {
    expect(read()).toEqual({ entries: [], warnings: [] });
  });

  it("ignores entries without a string id with one warning and gives them no entry", () => {
    const list = read({ file: "a.js", line: 1 }, { id: 7, file: "a.js", line: 1 }, null, "bp", checkout);

    expect(list).toEqual({
      entries: [{ kind: "valid", ...checkout }],
      warnings: ["4 breakpoints without a string id ignored"],
    });
  });

  it("uses the first entry of a repeated id and warns once", () => {
    const list = read(checkout, { ...checkout, line: 7 }, { ...checkout, line: 8 });

    expect(list).toEqual({
      entries: [{ kind: "valid", ...checkout }],
      warnings: ["2 repeated ids ignored; the first entry of an id is used"],
    });
  });

  it("reads only the first 200 entries and warns once about the rest", () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({ ...checkout, id: `bp-${String(index)}` }));

    const list = read(...entries);

    expect({ count: list?.entries.length, warnings: list?.warnings }).toEqual({
      count: 200,
      warnings: ["only the first 200 breakpoints are read; the other 5 are ignored"],
    });
  });

  it("gives every entry after the 100th an error", () => {
    const entries = Array.from({ length: 102 }, (_, index) => ({ ...checkout, id: `bp-${String(index)}` }));

    const list = read(...entries);

    expect(list?.entries.slice(99).map((entry) => entry.kind)).toEqual(["valid", "invalid", "invalid"]);
    expect(list?.entries[100]).toEqual({ kind: "invalid", id: "bp-100", message: "at most 100 breakpoints are set" });
  });

  it("does not count ignored entries towards the 100", () => {
    const ignored = Array.from({ length: 20 }, () => ({ file: "a.js", line: 1 }));
    const valid = Array.from({ length: 100 }, (_, index) => ({ ...checkout, id: `bp-${String(index)}` }));

    const list = read(...ignored, ...valid);

    expect(list?.entries.every((entry) => entry.kind === "valid")).toBe(true);
  });

  it.each([
    ["an id over 256 characters", { ...checkout, id: "x".repeat(257) }, "id must be at most 256 characters"],
    ["a missing file", { id: "bp-1", line: 1 }, "file must be a non-empty string of at most 1024 characters"],
    ["an empty file", { id: "bp-1", file: "", line: 1 }, "file must be a non-empty string of at most 1024 characters"],
    [
      "a file over 1024 characters",
      { id: "bp-1", file: "a".repeat(1025), line: 1 },
      "file must be a non-empty string of at most 1024 characters",
    ],
    ["a file that names no file", { id: "bp-1", file: "./", line: 1 }, "file must name a file"],
    ["a file of only separators", { id: "bp-1", file: "/", line: 1 }, "file must name a file"],
    ["a zero line", { ...checkout, line: 0 }, "line must be a positive integer"],
    ["a negative line", { ...checkout, line: -3 }, "line must be a positive integer"],
    ["a fractional line", { ...checkout, line: 1.5 }, "line must be a positive integer"],
    ["a line that is a string", { ...checkout, line: "42" }, "line must be a positive integer"],
    ["limits that are not an object", { ...checkout, limits: 5 }, "limits must be an object"],
    ["a null limits", { ...checkout, limits: null }, "limits must be an object"],
    ["a zero maxDepth", { ...checkout, limits: { maxDepth: 0 } }, "limits.maxDepth must be a positive integer"],
    ["a fractional maxItems", { ...checkout, limits: { maxItems: 2.5 } }, "limits.maxItems must be a positive integer"],
    [
      "a maxStringLength that is a string",
      { ...checkout, limits: { maxStringLength: "5" } },
      "limits.maxStringLength must be a positive integer",
    ],
  ])("gives %s an error with a message", (_name, entry, message) => {
    const list = read(entry);

    expect(list?.entries).toEqual([{ kind: "invalid", id: entry.id, message }]);
  });

  it("accepts an id of exactly 256 characters and a file of exactly 1024", () => {
    const entry = { id: "x".repeat(256), file: "a".repeat(1024), line: 1, expiresInMs: 1000 };

    expect(read(entry)?.entries.map((read) => read.kind)).toEqual(["valid"]);
  });
});
