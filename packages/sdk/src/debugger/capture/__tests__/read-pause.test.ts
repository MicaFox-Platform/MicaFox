import type { StackFrame, Value } from "@probex-platform/protocol";
import { describe, expect, it } from "vitest";

import {
  data,
  FakeInspector,
  number,
  pausedAt,
  reference,
  text,
  type FakeFrame,
} from "../../../../test/capture/fake-inspector.js";
import { cutSnapshot, readPause, type CaptureDependencies, type CaptureClock } from "../index.js";

const FIXED_CLOCK: CaptureClock = { now: () => 0, epochMs: () => 1_700_000_000_000 };

interface Setup {
  inspector: FakeInspector;
  dependencies: CaptureDependencies;
}

const setup = (overrides: Partial<CaptureDependencies> = {}): Setup => {
  const inspector = new FakeInspector();
  return {
    inspector,
    dependencies: {
      session: inspector,
      locateFrame: (spot) => ({
        file: `/app/script-${spot.scriptId}.js`,
        line: spot.lineNumber + 1,
        column: spot.columnNumber + 1,
      }),
      clock: FIXED_CLOCK,
      ...overrides,
    },
  };
};

// A frame whose local scope holds `variables`
const withLocals = (inspector: FakeInspector, variables: Array<ReturnType<typeof data>>): FakeFrame => {
  inspector.define("local", variables);
  return { functionName: "total", scopes: [{ type: "local", objectId: "local" }] };
};

const variableNames = (pause: ReturnType<typeof readPause>): string[] => pause.variables.map(({ name }) => name);

describe("readPause stack", () => {
  it("lists at most 20 frames, innermost first, with the function name and the located position", () => {
    const { dependencies } = setup();
    const frames = Array.from({ length: 25 }, (_unused, index) => ({
      functionName: `f${String(index)}`,
      scriptId: String(index),
      lineNumber: index,
      columnNumber: 4,
    }));

    const { stack } = readPause(pausedAt(...frames), [undefined], dependencies);

    expect({ count: stack.length, first: stack[0], last: stack[19] }).toEqual({
      count: 20,
      first: { function: "f0", file: "/app/script-0.js", line: 1, column: 5 },
      last: { function: "f19", file: "/app/script-19.js", line: 20, column: 5 },
    });
  });

  it("gives an anonymous function the name an empty string", () => {
    const { dependencies } = setup();

    const { stack } = readPause(pausedAt({ functionName: "" }), [undefined], dependencies);

    expect(stack.map((frame: StackFrame) => frame.function)).toEqual([""]);
  });

  it("throws CaptureError for a pause without call frames", () => {
    const { dependencies } = setup();

    expect(() => readPause({ callFrames: [] }, [undefined], dependencies)).toThrow(
      "the pause has no innermost call frame to read",
    );
  });

  it("drops an outer call frame whose location is malformed", () => {
    const { dependencies } = setup();
    const params = {
      callFrames: [
        { functionName: "inner", location: { scriptId: "1", lineNumber: 0, columnNumber: 0 } },
        { functionName: "badId", location: { scriptId: 7, lineNumber: 0, columnNumber: 0 } },
        { functionName: "badLine", location: { scriptId: "1", lineNumber: "0", columnNumber: 0 } },
        { functionName: "outer", location: { scriptId: "1", lineNumber: 0, columnNumber: 0 } },
      ],
    };

    const { stack } = readPause(params, [undefined], dependencies);

    expect(stack.map((frame: StackFrame) => frame.function)).toEqual(["inner", "outer"]);
  });

  it("throws CaptureError when the innermost call frame is malformed, so no caller's variables stand in", () => {
    const { dependencies } = setup();
    const params = {
      callFrames: [
        { functionName: "broken" },
        { functionName: "caller", location: { scriptId: "1", lineNumber: 0, columnNumber: 0 } },
      ],
    };

    expect(() => readPause(params, [undefined], dependencies)).toThrow("the pause has no innermost call frame to read");
  });

  it("stamps the time of the clock", () => {
    const { dependencies } = setup();

    const { time } = readPause(pausedAt({}), [undefined], dependencies);

    expect(time).toBe(1_700_000_000_000);
  });
});

describe("readPause variables", () => {
  it("lists this, then the local, block and closure scopes, innermost first", () => {
    const { inspector, dependencies } = setup();
    inspector.define("local", [data("a", number(1))]);
    inspector.define("block", [data("b", number(2))]);
    inspector.define("closure", [data("c", number(3))]);
    const frame: FakeFrame = {
      receiver: text("receiver"),
      scopes: [
        { type: "local", objectId: "local" },
        { type: "block", objectId: "block" },
        { type: "closure", objectId: "closure" },
      ],
    };

    const pause = readPause(pausedAt(frame), [undefined], dependencies);

    expect(variableNames(pause)).toEqual(["this", "a", "b", "c"]);
  });

  it("lists a shadowed name once, with the value of the innermost scope", () => {
    const { inspector, dependencies } = setup();
    inspector.define("local", [data("count", number(1))]);
    inspector.define("closure", [data("count", number(99)), data("other", number(3))]);
    const frame: FakeFrame = {
      scopes: [
        { type: "local", objectId: "local" },
        { type: "closure", objectId: "closure" },
      ],
    };

    const { variables } = readPause(pausedAt(frame), [undefined], dependencies);

    expect(variables).toEqual([
      { name: "this", value: { type: "undefined" } },
      { name: "count", value: { type: "number", value: 1 } },
      { name: "other", value: { type: "number", value: 3 } },
    ]);
  });

  it("leaves out the global and script scopes without reading them", () => {
    const { inspector, dependencies } = setup();
    inspector.define("local", [data("a", number(1))]);
    inspector.define("global", [data("process", number(0))]);
    const frame: FakeFrame = {
      scopes: [
        { type: "local", objectId: "local" },
        { type: "script", objectId: "script" },
        { type: "global", objectId: "global" },
      ],
    };

    const pause = readPause(pausedAt(frame), [undefined], dependencies);

    expect({ names: variableNames(pause), asked: inspector.posted.map((call) => call.objectId) }).toEqual({
      names: ["this", "a"],
      asked: ["local"],
    });
  });

  it.each(["catch", "with", "eval", "module"])("reads the %s scope", (type) => {
    const { inspector, dependencies } = setup();
    inspector.define("scope", [data("inScope", number(1))]);

    const pause = readPause(pausedAt({ scopes: [{ type, objectId: "scope" }] }), [undefined], dependencies);

    expect(variableNames(pause)).toEqual(["this", "inScope"]);
  });

  it("stands for the names of a scope that cannot be read with one unavailable variable", () => {
    const { inspector, dependencies } = setup();
    inspector.define("closure", [data("c", number(3))]);
    inspector.fail("local");
    const frame: FakeFrame = {
      scopes: [
        { type: "local", objectId: "local" },
        { type: "closure", objectId: "closure" },
      ],
    };

    const { variables } = readPause(pausedAt(frame), [undefined], dependencies);

    expect(variables.slice(1)).toEqual([
      { name: "<local scope>", value: { type: "unavailable", reason: "the inspector could not read the value" } },
      { name: "c", value: { type: "number", value: 3 } },
    ]);
  });
});

describe("readPause reading values", () => {
  it("makes a value whose Runtime.getProperties failed unavailable and goes on with the next", () => {
    const { inspector, dependencies } = setup();
    const frame = withLocals(inspector, [data("broken", reference("broken")), data("fine", number(5))]);
    inspector.fail("broken");

    const { variables } = readPause(pausedAt(frame), [undefined], dependencies);

    expect(variables.slice(1)).toEqual([
      { name: "broken", value: { type: "unavailable", reason: "the inspector could not read the value" } },
      { name: "fine", value: { type: "number", value: 5 } },
    ]);
  });

  it("reads the own properties of an object in one call", () => {
    const { inspector, dependencies } = setup();
    const frame = withLocals(inspector, [data("order", reference("order"))]);
    inspector.define("order", [data("id", number(1)), data("qty", number(2))]);

    readPause(pausedAt(frame), [undefined], dependencies);

    expect(inspector.callsAbout("order")).toBe(1);
  });

  it("keeps maxItems properties of an object and sets truncated when it has more", () => {
    const { inspector, dependencies } = setup();
    const frame = withLocals(inspector, [data("big", reference("big"))]);
    inspector.define(
      "big",
      Array.from({ length: 30 }, (_unused, index) => data(`k${String(index)}`, number(index))),
    );

    const { variables } = readPause(pausedAt(frame), [{ maxItems: 25 }], dependencies);

    const big = variables.find(({ name }) => name === "big")?.value;
    expect({
      type: big?.type,
      kept: big?.type === "object" ? big.properties?.length : undefined,
      truncated: big?.type === "object" ? big.truncated : undefined,
    }).toEqual({ type: "object", kept: 25, truncated: true });
  });

  it.each([
    ["an array", { subtype: "array", className: "Array", description: "Array(150)" }],
    ["a typed array", { subtype: "typedarray", className: "Uint8Array", description: "Uint8Array(150)" }],
    ["a set", { subtype: "set", className: "Set", description: "Set(150)" }],
    ["a map", { subtype: "map", className: "Map", description: "Map(150)" }],
  ])("never requests the children of %s with more than maxItems", (_name, describe) => {
    const { inspector, dependencies } = setup();
    const frame = withLocals(inspector, [data("huge", reference("huge", describe))]);

    readPause(pausedAt(frame), [undefined], dependencies);

    expect(inspector.callsAbout("huge")).toBe(0);
  });

  it("posts only Runtime.getProperties", () => {
    const { inspector, dependencies } = setup();
    const frame = withLocals(inspector, [
      data("o", reference("o")),
      data("e", reference("e", { subtype: "error", className: "Error" })),
      data("f", reference("f", { description: "function f() {}" })),
    ]);
    inspector.define("o", [data("x", number(1))]);
    inspector.define("e", [data("message", text("m"))]);
    inspector.define("f", [data("name", text("f"))]);

    readPause(pausedAt(frame), [undefined], dependencies);

    expect(new Set(inspector.posted.map((call) => call.method))).toEqual(new Set(["Runtime.getProperties"]));
  });

  it("reads once within the largest limits of the entries, then cuts each with no further call", () => {
    const { inspector, dependencies } = setup();
    const frame = withLocals(inspector, [
      data("list", reference("list", { subtype: "array", className: "Array", description: "Array(8)" })),
    ]);
    inspector.define(
      "list",
      Array.from({ length: 8 }, (_unused, index) => data(String(index), number(index))),
    );

    const read = readPause(pausedAt(frame), [{ maxItems: 5 }, { maxItems: 10 }], dependencies);
    const callsAfterRead = inspector.posted.length;
    const small = cutSnapshot(read, { breakpointId: "small", limits: { maxItems: 5 } });
    const large = cutSnapshot(read, { breakpointId: "large", limits: { maxItems: 10 } });

    const listOf = (snapshot: typeof small): Value | undefined =>
      snapshot.variables.find(({ name }) => name === "list")?.value;
    expect({
      calls: inspector.posted.length - callsAfterRead,
      small: listOf(small),
      largeItems: (listOf(large) as { items?: Value[] } | undefined)?.items?.length,
    }).toEqual({ calls: 0, small: { type: "array", length: 8 }, largeItems: 8 });
  });
});

describe("readPause limits of time and size", () => {
  const manyObjects = (inspector: FakeInspector): FakeFrame => {
    const frame = withLocals(
      inspector,
      Array.from({ length: 6 }, (_unused, index) => data(`o${String(index)}`, reference(`o${String(index)}`))),
    );
    for (let index = 0; index < 6; index += 1) {
      inspector.define(`o${String(index)}`, [data("x", number(index))]);
    }

    return frame;
  };

  it("makes the values not yet read unavailable at the time limit, and truncates", () => {
    let elapsedMs = 0;
    const { inspector, dependencies } = setup({ clock: { now: () => elapsedMs, epochMs: () => 0 } });
    const frame = manyObjects(inspector);
    // Every command takes 3 ms: the scope, then o0, o1 and o2 use 12 ms
    inspector.onPost = () => {
      elapsedMs += 3;
    };

    const pause = readPause(pausedAt(frame), [undefined], dependencies);

    expect({
      kinds: pause.variables.slice(1).map(({ value }) => value.type),
      reason: pause.variables.at(-1)?.value,
      truncated: pause.truncated,
    }).toEqual({
      kinds: ["object", "object", "object", "unavailable"],
      reason: { type: "unavailable", reason: "the pause reached its time limit" },
      truncated: true,
    });
  });

  it("makes the values not yet read unavailable at the size limit, and truncates", () => {
    const { inspector, dependencies } = setup({ budget: { maxMs: 10, maxBytes: 400 } });
    const frame = manyObjects(inspector);

    const pause = readPause(pausedAt(frame), [undefined], dependencies);

    expect({
      last: pause.variables.at(-1)?.value,
      truncated: pause.truncated,
    }).toEqual({ last: { type: "unavailable", reason: "the snapshot reached its size limit" }, truncated: true });
  });

  it("stays within the size limit for a scope with thousands of variables", () => {
    const { inspector, dependencies } = setup();
    const frame = withLocals(
      inspector,
      Array.from({ length: 5000 }, (_unused, index) => data(`variable${String(index)}`, number(index))),
    );

    const pause = readPause(pausedAt(frame), [undefined], dependencies);
    const bytes = JSON.stringify(cutSnapshot(pause, { breakpointId: "bp-1" })).length;

    expect({ isWithin: bytes <= 64 * 1024 + 512, truncated: pause.truncated }).toEqual({
      isWithin: true,
      truncated: true,
    });
  });

  it("leaves out the properties of an object after the first one the budget left unread, and truncates it", () => {
    let elapsedMs = 0;
    const { inspector, dependencies } = setup({ clock: { now: () => elapsedMs, epochMs: () => 0 } });
    const frame = withLocals(inspector, [data("order", reference("order"))]);
    inspector.define("order", [data("a", reference("a")), data("b", number(2)), data("c", number(3))]);
    inspector.define("a", []);
    inspector.onPost = () => {
      elapsedMs += 4;
    };

    const { variables } = readPause(pausedAt(frame), [undefined], dependencies);

    expect(variables.find(({ name }) => name === "order")?.value).toEqual({
      type: "object",
      className: "Object",
      properties: [
        { name: "a", value: { type: "object", className: "Object", properties: [] } },
        { name: "b", value: { type: "unavailable", reason: "the pause reached its time limit" } },
      ],
      truncated: true,
    });
  });

  it("leaves out the items of an array the budget ran out in, which means not read", () => {
    let elapsedMs = 0;
    const { inspector, dependencies } = setup({ clock: { now: () => elapsedMs, epochMs: () => 0 } });
    const frame = withLocals(inspector, [
      data("list", reference("list", { subtype: "array", className: "Array", description: "Array(2)" })),
    ]);
    inspector.define("list", [data("0", reference("item")), data("1", number(2))]);
    inspector.define("item", []);
    inspector.onPost = () => {
      elapsedMs += 4;
    };

    const { variables } = readPause(pausedAt(frame), [undefined], dependencies);

    expect(variables.find(({ name }) => name === "list")?.value).toEqual({ type: "array", length: 2 });
  });

  it("does not truncate a read that stays within both limits", () => {
    const { inspector, dependencies } = setup();
    const frame = manyObjects(inspector);

    const pause = readPause(pausedAt(frame), [undefined], dependencies);

    expect(pause.truncated).toBe(false);
  });

  it("carries truncated over to every snapshot cut from the read", () => {
    const { inspector, dependencies } = setup({ budget: { maxMs: 10, maxBytes: 400 } });
    const frame = manyObjects(inspector);
    const pause = readPause(pausedAt(frame), [undefined], dependencies);

    const snapshot = cutSnapshot(pause, { breakpointId: "bp-1" });

    expect(snapshot.truncated).toBe(true);
  });
});
