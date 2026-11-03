import { describe, expect, it } from "vitest";

import { encodeVlq } from "../../../../test/source-maps/encode-mappings.js";
import { VlqCursor } from "../decode-mappings.js";

const readAll = (text: string): number[] => {
  const cursor = new VlqCursor(text);
  const values: number[] = [];
  while (cursor.peekCode() !== -1) {
    values.push(cursor.read());
  }

  return values;
};

describe("VlqCursor", () => {
  it.each([
    ["A", 0],
    ["C", 1],
    ["D", -1],
    ["E", 2],
    ["F", -2],
    ["2H", 123],
    ["mD", 51],
    ["gB", 16],
    ["hB", -16],
    ["+/////D", 2147483647],
  ])("reads the known vector %s as %d", (text, expected) => {
    expect(readAll(text)).toEqual([expected]);
  });

  it("reads a segment of several values in a row", () => {
    expect(readAll("AAgBC")).toEqual([0, 0, 16, 1]);
  });

  it("reads multi-character values next to single-character ones", () => {
    expect(readAll("gB2HCD")).toEqual([16, 123, 1, -1]);
  });

  it("reads a negative zero as zero", () => {
    expect(Object.is(readAll("B")[0], 0)).toBe(true);
  });

  it.each([-1_000_000, -33, -16, -1, 0, 1, 15, 16, 31, 32, 1023, 65_535, 1_048_576, 2_147_483_647])(
    "reads what the reference encoder writes for %d",
    (value) => {
      expect(readAll(encodeVlq(value))).toEqual([value]);
    },
  );

  it("stops at the position after the value it read", () => {
    const cursor = new VlqCursor("gBA,");

    cursor.read();

    expect(cursor.position).toBe(2);
  });

  it("reports a character outside the base64 alphabet", () => {
    expect(() => new VlqCursor("A$").read()).not.toThrow();
    expect(() => new VlqCursor("$").read()).toThrow("mappings hold a bad VLQ character");
  });

  it("reports a non-ASCII character", () => {
    expect(() => new VlqCursor("é").read()).toThrow("mappings hold a bad VLQ character");
  });

  it("reports a value cut off by the end of the text", () => {
    expect(() => new VlqCursor("g").read()).toThrow("mappings end inside a VLQ value");
  });

  it("reports a value with more continuation digits than a position needs", () => {
    expect(() => new VlqCursor("gggggggggA").read()).toThrow("VLQ value is too large");
  });
});
