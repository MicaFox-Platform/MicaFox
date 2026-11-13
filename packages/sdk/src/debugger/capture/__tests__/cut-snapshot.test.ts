import type { StackFrame, Value, Variable } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import { cutSnapshot } from "../cut-snapshot.js";
import type { PauseRead } from "../read-pause.js";

const number = (value: number): Value => ({ type: "number", value });
const object = (properties?: Variable[], truncated?: true): Value => ({
  type: "object",
  className: "Object",
  ...(properties === undefined ? {} : { properties }),
  ...(truncated === undefined ? {} : { truncated }),
});

const STACK: StackFrame[] = [{ function: "total", file: "/app/checkout.ts", line: 8, column: 5 }];

const readOf = (variables: Variable[], truncated = false): PauseRead => ({
  time: 1_700_000_000_000,
  stack: STACK,
  variables,
  truncated,
});

const cut = (
  value: Value,
  limits: { maxDepth?: number; maxItems?: number; maxStringLength?: number },
): Value | undefined =>
  cutSnapshot(readOf([{ name: "v", value }]), { breakpointId: "bp-1", limits }).variables[0]?.value;

describe("cutSnapshot", () => {
  it("makes a snapshot of the breakpoint with the time and stack of the read", () => {
    const snapshot = cutSnapshot(readOf([{ name: "v", value: number(1) }]), { breakpointId: "bp-1" });

    expect(snapshot).toEqual({
      version: 1,
      module: "debugger",
      type: "snapshot",
      breakpointId: "bp-1",
      time: 1_700_000_000_000,
      stack: STACK,
      variables: [{ name: "v", value: number(1) }],
    });
  });

  it("sets truncated for a truncated read and leaves it out otherwise", () => {
    const truncated = cutSnapshot(readOf([], true), { breakpointId: "bp-1" });
    const complete = cutSnapshot(readOf([]), { breakpointId: "bp-1" });

    expect({ truncated: truncated.truncated, complete: "truncated" in complete }).toEqual({
      truncated: true,
      complete: false,
    });
  });

  it("cuts a string to maxStringLength, keeps its full length and never splits a pair", () => {
    const value: Value = { type: "string", value: "a\u{1F600}b", length: 4 };

    expect(cut(value, { maxStringLength: 2 })).toEqual({ type: "string", value: "a", length: 4 });
  });

  it("cuts the message and stack of an error", () => {
    const value: Value = { type: "error", className: "Error", message: "abcdef", stack: "ghijkl" };

    expect(cut(value, { maxStringLength: 3 })).toEqual({
      type: "error",
      className: "Error",
      message: "abc",
      stack: "ghi",
    });
  });

  it("keeps maxItems properties of an object and sets truncated", () => {
    const value = object([
      { name: "a", value: number(1) },
      { name: "b", value: number(2) },
      { name: "c", value: number(3) },
    ]);

    expect(cut(value, { maxItems: 2 })).toEqual(
      object(
        [
          { name: "a", value: number(1) },
          { name: "b", value: number(2) },
        ],
        true,
      ),
    );
  });

  it("keeps truncated of an object that the read already cut", () => {
    const value = object([{ name: "a", value: number(1) }], true);

    expect(cut(value, { maxItems: 5 })).toEqual(object([{ name: "a", value: number(1) }], true));
  });

  it("leaves out the properties of an object below maxDepth", () => {
    const value = object([{ name: "a", value: object([{ name: "b", value: number(1) }]) }]);

    expect(cut(value, { maxDepth: 1 })).toEqual(object([{ name: "a", value: object() }]));
  });

  it("keeps all items of an array with at most maxItems and drops those of a larger one", () => {
    const items = [number(1), number(2), number(3)];
    const array: Value = { type: "array", length: 3, items };

    expect([cut(array, { maxItems: 3 }), cut(array, { maxItems: 2 })]).toEqual([array, { type: "array", length: 3 }]);
  });

  it("cuts a set and a map like an array", () => {
    const set: Value = { type: "set", size: 2, items: [number(1), number(2)] };
    const map: Value = {
      type: "map",
      size: 1,
      entries: [{ key: number(1), value: object([{ name: "a", value: number(1) }]) }],
    };

    expect([cut(set, { maxItems: 1 }), cut(map, { maxDepth: 1 })]).toEqual([
      { type: "set", size: 2 },
      { type: "map", size: 1, entries: [{ key: number(1), value: object() }] },
    ]);
  });

  it("leaves out the items of an array below maxDepth", () => {
    const value = object([{ name: "list", value: { type: "array", length: 1, items: [number(1)] } }]);

    expect(cut(value, { maxDepth: 1 })).toEqual(object([{ name: "list", value: { type: "array", length: 1 } }]));
  });

  it("does not change the read it cuts", () => {
    const read = readOf([
      {
        name: "v",
        value: object([
          { name: "a", value: number(1) },
          { name: "b", value: number(2) },
        ]),
      },
    ]);
    const before = structuredClone(read);

    cutSnapshot(read, { breakpointId: "bp-1", limits: { maxItems: 1 } });

    expect(read).toEqual(before);
  });
});
