// A framework handler's `request` and `response` come before its own variables and are large: on a slow machine
// reading them can take the whole pause. The fake clock moves 1 ms per inspector command, as such a machine would.

import type { Value, Variable } from "@micafox/protocol";
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
import { readPause, type CaptureDependencies } from "../index.js";

interface Setup {
  inspector: FakeInspector;
  dependencies: CaptureDependencies;
  elapsedMs: () => number;
}

const setup = (commandMs: number): Setup => {
  let nowMs = 0;
  const inspector = new FakeInspector();
  inspector.onPost = () => {
    nowMs += commandMs;
  };

  return {
    inspector,
    elapsedMs: () => nowMs,
    dependencies: {
      session: inspector,
      locateFrame: (spot) => ({ file: "/app/quote.js", line: spot.lineNumber + 1, column: spot.columnNumber + 1 }),
      isSecret: () => false,
      clock: { now: () => nowMs, epochMs: () => 0 },
    },
  };
};

// An object of twelve properties, each an object of its own: more commands than the whole pause allows
const defineLargeObject = (inspector: FakeInspector, objectId: string): void => {
  const names = Array.from({ length: 12 }, (_unused, index) => `${objectId}${String(index)}`);
  inspector.define(
    objectId,
    names.map((name) => data(name, reference(name))),
  );
  for (const name of names) {
    inspector.define(name, [data("value", number(1))]);
  }
};

// The handler's own variables: three primitives and an object
const LOCALS: Record<string, Value> = {
  sku: { type: "string", value: "SKU-2", length: 5 },
  quantity: { type: "number", value: 3 },
  total: { type: "number", value: 13.5 },
  quote: {
    type: "object",
    className: "Object",
    properties: [{ name: "total", value: { type: "number", value: 13.5 } }],
  },
};

const defineLocals = (inspector: FakeInspector, parameters: Array<ReturnType<typeof data>>): FakeFrame => {
  inspector.define("quote", [data("total", number(13.5))]);
  inspector.define("local", [
    ...parameters,
    data("sku", text("SKU-2")),
    data("quantity", number(3)),
    data("total", number(13.5)),
    data("quote", reference("quote")),
  ]);
  return { functionName: "quote", scopes: [{ type: "local", objectId: "local" }] };
};

// `(request, response) => { const sku, quantity, total, quote }`: V8 lists the parameters first
const expressHandler = (inspector: FakeInspector): FakeFrame => {
  defineLargeObject(inspector, "request");
  defineLargeObject(inspector, "response");
  return defineLocals(inspector, [
    data("request", reference("request", { className: "IncomingMessage" })),
    data("response", reference("response", { className: "ServerResponse" })),
  ]);
};

const valueOf = (variables: readonly Variable[], name: string): Value | undefined =>
  variables.find((variable) => variable.name === name)?.value;

const readLocals = (variables: readonly Variable[]): Record<string, Value | undefined> =>
  Object.fromEntries(Object.keys(LOCALS).map((name) => [name, valueOf(variables, name)]));

describe("readPause of a framework handler", () => {
  it("keeps every local of a handler whose request and response would fill the pause", () => {
    const { inspector, dependencies } = setup(1);

    const { variables } = readPause(pausedAt(expressHandler(inspector)), [undefined], dependencies);

    expect(readLocals(variables)).toEqual(LOCALS);
  });

  it("keeps request and response, the one read last as its shell, and truncates the snapshot", () => {
    const { inspector, dependencies } = setup(1);

    const pause = readPause(pausedAt(expressHandler(inspector)), [undefined], dependencies);

    expect({
      request: valueOf(pause.variables, "request"),
      response: valueOf(pause.variables, "response"),
      truncated: pause.truncated,
    }).toEqual({
      request: { type: "object", className: "IncomingMessage" },
      response: expect.objectContaining({ className: "ServerResponse", truncated: true }) as unknown,
      truncated: true,
    });
  });

  it("sends no inspector command once the pause has used its 10 ms", () => {
    const { inspector, dependencies, elapsedMs } = setup(1);

    readPause(pausedAt(expressHandler(inspector)), [undefined], dependencies);

    expect(elapsedMs()).toBe(10);
  });

  it("keeps the values that came with the scope when listing it took the whole pause", () => {
    const { inspector, dependencies } = setup(10);

    const { variables } = readPause(pausedAt(expressHandler(inspector)), [undefined], dependencies);

    expect(readLocals(variables)).toEqual({ ...LOCALS, quote: { type: "object", className: "Object" } });
  });

  it("reads a controller's own variables before a large `this`", () => {
    const { inspector, dependencies } = setup(1);
    defineLargeObject(inspector, "controller");
    const frame: FakeFrame = {
      ...defineLocals(inspector, []),
      receiver: reference("controller", { className: "QuoteController" }),
    };

    const { variables } = readPause(pausedAt(frame), [undefined], dependencies);

    expect({ locals: readLocals(variables), receiver: valueOf(variables, "this") }).toEqual({
      locals: LOCALS,
      receiver: expect.objectContaining({ className: "QuoteController", truncated: true }) as unknown,
    });
  });

  it("cuts a value read on at the size limit, after the variables it came with were kept", () => {
    const { inspector, dependencies } = setup(0);
    inspector.define(
      "order",
      Array.from({ length: 20 }, (_unused, index) => data(`line${String(index)}`, text("x".repeat(100)))),
    );
    inspector.define("local", [data("order", reference("order")), data("sku", text("SKU-2"))]);
    const frame: FakeFrame = { functionName: "quote", scopes: [{ type: "local", objectId: "local" }] };

    const pause = readPause(pausedAt(frame), [undefined], { ...dependencies, budget: { maxMs: 10, maxBytes: 600 } });

    const order = valueOf(pause.variables, "order");
    expect({
      sku: valueOf(pause.variables, "sku"),
      orderTruncated: order?.type === "object" && order.truncated,
      lastLine: order?.type === "object" ? order.properties?.at(-1)?.value : undefined,
      truncated: pause.truncated,
    }).toEqual({
      sku: LOCALS.sku,
      orderTruncated: true,
      lastLine: { type: "unavailable", reason: "the snapshot reached its size limit" },
      truncated: true,
    });
  });

  it("makes a variable unavailable when reading it on fails, and keeps the others", () => {
    const { inspector, dependencies } = setup(1);
    const frame = defineLocals(inspector, []);
    inspector.fail("quote");

    const { variables } = readPause(pausedAt(frame), [undefined], dependencies);

    expect(readLocals(variables)).toEqual({
      ...LOCALS,
      quote: { type: "unavailable", reason: "the inspector could not read the value" },
    });
  });

  it("keeps the reason of an array of unknown length when the time runs out, and does not truncate for it", () => {
    const { inspector, dependencies } = setup(10);
    inspector.define("local", [
      data("lines", reference("lines", { subtype: "array", className: "Array", description: "Array" })),
    ]);
    const frame: FakeFrame = { functionName: "quote", scopes: [{ type: "local", objectId: "local" }] };

    const pause = readPause(pausedAt(frame), [undefined], dependencies);

    expect({ lines: valueOf(pause.variables, "lines"), truncated: pause.truncated }).toEqual({
      lines: { type: "unavailable", reason: "the length of the array is unknown" },
      truncated: false,
    });
  });
});
