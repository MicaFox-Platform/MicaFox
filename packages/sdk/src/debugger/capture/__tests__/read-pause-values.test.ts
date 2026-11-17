import type { Value } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import { readRealPause, type RealPauseOptions } from "../../../../test/capture/real-pause.js";

// The variables are declared in a function of the real V8 of the test process; `v` is the one under test
const valueOf = (body: string, options?: RealPauseOptions): Value | undefined =>
  readRealPause(body, options).read.variables.find((variable) => variable.name === "v")?.value;

const number = (value: number | "NaN" | "Infinity" | "-Infinity" | "-0"): Value => ({ type: "number", value });
const string = (value: string, length = value.length): Value => ({ type: "string", value, length });

describe("readPause values", () => {
  it.each<[string, string, Value]>([
    ["undefined", "const v = undefined;", { type: "undefined" }],
    ["null", "const v = null;", { type: "null" }],
    ["a boolean", "const v = true;", { type: "boolean", value: true }],
    ["a number", "const v = 42.5;", number(42.5)],
    ["-0", "const v = -0;", number("-0")],
    ["NaN", "const v = NaN;", number("NaN")],
    ["Infinity", "const v = Infinity;", number("Infinity")],
    ["-Infinity", "const v = -Infinity;", number("-Infinity")],
    ["a bigint", "const v = 12345678901234567890n;", { type: "bigint", value: "12345678901234567890" }],
    ["a symbol", 'const v = Symbol("tag");', { type: "symbol", value: "Symbol(tag)" }],
    ["a string", 'const v = "total";', string("total")],
    [
      "a date as ISO",
      'const v = new Date("2024-05-06T07:08:09Z");',
      { type: "date", value: "2024-05-06T07:08:09.000Z" },
    ],
    ["an invalid date", "const v = new Date(NaN);", { type: "unavailable", reason: "the date is invalid" }],
    ["a function", "const v = function named() {};", { type: "function", name: "named" }],
    ["an arrow function named by its variable", "const v = (a) => a;", { type: "function", name: "v" }],
    ["an anonymous function", "const v = (() => () => 1)();", { type: "function", name: "" }],
    ["a class", "const v = class Order {};", { type: "function", name: "Order" }],
  ])("reads %s", (_name, body, expected) => {
    expect(valueOf(body)).toEqual(expected);
  });

  it("keeps the full length of a string cut to maxStringLength", () => {
    const value = valueOf('const v = "x".repeat(300);');

    expect(value).toEqual(string("x".repeat(256), 300));
  });

  it("never splits a surrogate pair at maxStringLength", () => {
    const value = valueOf('const v = "a\\u{1F600}b";', { limits: [{ maxStringLength: 2 }] });

    expect(value).toEqual(string("a", 4));
  });

  it("reads an error with its class, message and stack", () => {
    const value = valueOf('const v = new RangeError("out of range");');

    expect(value).toEqual({
      type: "error",
      className: "RangeError",
      message: "out of range",
      stack: expect.stringMatching(/^RangeError: out of range\n\s+at .*\.run /) as unknown,
    });
  });

  it("reads an object with its class name and own properties", () => {
    const value = valueOf("class Order { constructor() { this.id = 7; this.note = 'rush'; } } const v = new Order();");

    expect(value).toEqual({
      type: "object",
      className: "Order",
      properties: [
        { name: "id", value: number(7) },
        { name: "note", value: string("rush") },
      ],
    });
  });

  it("reads a typed array as an array of numbers", () => {
    const value = valueOf("const v = new Uint8Array([1, 2, 3]);");

    expect(value).toEqual({ type: "array", length: 3, items: [number(1), number(2), number(3)] });
  });

  it("reads a Buffer as an array of numbers", () => {
    const value = valueOf('const v = Buffer.from("hi");');

    expect(value).toEqual({ type: "array", length: 2, items: [number(104), number(105)] });
  });

  it("reads an array and shows a hole as undefined", () => {
    const value = valueOf("const v = [1, , 'c'];");

    expect(value).toEqual({ type: "array", length: 3, items: [number(1), { type: "undefined" }, string("c")] });
  });

  it("reads a set", () => {
    const value = valueOf("const v = new Set([1, 'two']);");

    expect(value).toEqual({ type: "set", size: 2, items: [number(1), string("two")] });
  });

  it("reads a map with object keys and values", () => {
    const value = valueOf("const v = new Map([['a', { x: 1 }]]);");

    expect(value).toEqual({
      type: "map",
      size: 1,
      entries: [
        {
          key: string("a"),
          value: { type: "object", className: "Object", properties: [{ name: "x", value: number(1) }] },
        },
      ],
    });
  });

  it("keeps only the size of an array with more items than maxItems", () => {
    const value = valueOf("const v = Array.from({ length: 150 }, (_, i) => i);");

    expect(value).toEqual({ type: "array", length: 150 });
  });

  it("keeps only the size of a typed array, set and map with more items than maxItems", () => {
    const sizes = [
      valueOf("const v = new Uint8Array(150);"),
      valueOf("const v = new Set(Array.from({ length: 25 }, (_, i) => i));"),
      valueOf("const v = new Map(Array.from({ length: 25 }, (_, i) => [i, i]));"),
    ];

    expect(sizes).toEqual([
      { type: "array", length: 150 },
      { type: "set", size: 25 },
      { type: "map", size: 25 },
    ]);
  });

  it("keeps maxItems properties of an object and sets truncated", () => {
    const value = valueOf("const v = Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['k' + i, i]));");

    expect({
      truncated: value?.type === "object" ? value.truncated : undefined,
      kept: value?.type === "object" ? value.properties?.map(({ name }) => name) : undefined,
    }).toEqual({ truncated: true, kept: Array.from({ length: 20 }, (_unused, index) => `k${String(index)}`) });
  });

  it("leaves out the properties of an object below maxDepth", () => {
    const value = valueOf("const v = { a: { b: { c: { d: 1 } } } };");

    expect(value).toEqual({
      type: "object",
      className: "Object",
      properties: [
        {
          name: "a",
          value: {
            type: "object",
            className: "Object",
            properties: [
              {
                name: "b",
                value: {
                  type: "object",
                  className: "Object",
                  properties: [{ name: "c", value: { type: "object", className: "Object" } }],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("gives accessor for a getter and never runs it", () => {
    const value = valueOf("const v = { get total() { globalThis.micafoxGetterRan = true; return 1; }, plain: 2 };");

    const ran: unknown = Reflect.get(globalThis, "micafoxGetterRan");
    expect({ value, ran }).toEqual({
      value: {
        type: "object",
        className: "Object",
        properties: [
          { name: "total", value: { type: "accessor" } },
          { name: "plain", value: number(2) },
        ],
      },
      ran: undefined,
    });
  });

  it("does not run the traps of a proxy", () => {
    const value = valueOf(
      "const v = new Proxy({}, { ownKeys() { globalThis.micafoxTrapRan = true; return []; }, get() { globalThis.micafoxTrapRan = true; } });",
    );

    const ran: unknown = Reflect.get(globalThis, "micafoxTrapRan");
    expect({ value, ran }).toEqual({
      value: { type: "object", className: "Object", properties: [] },
      ran: undefined,
    });
  });

  it("repeats a cycle down to maxDepth instead of marking it circular", () => {
    const value = valueOf("const v = { n: 1 }; v.self = v;");

    const self = { type: "object", className: "Object" } as const;
    const level = (inner: Value): Value => ({
      type: "object",
      className: "Object",
      properties: [
        { name: "n", value: number(1) },
        { name: "self", value: inner },
      ],
    });
    expect(value).toEqual(level(level(level(self))));
  });

  it("repeats a shared object that is not on the path", () => {
    const value = valueOf("const shared = { x: 1 }; const v = { a: shared, b: shared };");

    const sharedValue: Value = {
      type: "object",
      className: "Object",
      properties: [{ name: "x", value: number(1) }],
    };
    expect(value).toEqual({
      type: "object",
      className: "Object",
      properties: [
        { name: "a", value: sharedValue },
        { name: "b", value: sharedValue },
      ],
    });
  });
});

describe("readPause with a real V8", () => {
  it("posts only Runtime.getProperties", () => {
    const { commands } = readRealPause("const v = { a: [1, 2], f() {}, e: new Error('x'), m: new Map([[1, 2]]) };");

    expect(new Set(commands)).toEqual(new Set(["Runtime.getProperties"]));
  });
});
