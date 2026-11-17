import type { Snapshot, Value } from "@micafox/protocol";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  TOTAL_OF_TWO_ITEMS,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";

let test: BreakpointsUnderTest;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  test.dispose();
  vi.useRealTimers();
});

// The lines held during a pause are written in a setImmediate after the thread resumes
const runImmediates = (): void => {
  vi.advanceTimersByTime(0);
};

/** Line 6 of the checkout fixture: `return sum`, reached once per call with `items` in scope. */
const RETURN_LINE = 6;

const loadCheckout = () => test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));

const entry = (id: string, limits?: object) => ({
  id,
  file: test.fixtures.file("orders/checkout.cjs"),
  line: RETURN_LINE,
  ...(limits === undefined ? {} : { limits }),
});

const variable = (snapshot: Snapshot | undefined, name: string): Value | undefined =>
  snapshot?.variables.find((found) => found.name === name)?.value;

describe("Pauses capturing", () => {
  it("sends one snapshot per entry on the hit breakpoint, read once and cut to each entry's own limits", () => {
    test = createBreakpoints();
    const module = loadCheckout();
    test.apply(entry("bp-small", { maxItems: 1 }), entry("bp-full"));

    module.total(TWO_ITEMS);

    expect({
      pauses: test.session.pauses.length,
      ids: test.snapshots.map((snapshot) => snapshot.breakpointId),
      small: variable(test.snapshots[0], "items"),
      fullItems: (variable(test.snapshots[1], "items") as { items?: unknown[] } | undefined)?.items?.length,
    }).toEqual({ pauses: 1, ids: ["bp-small", "bp-full"], small: { type: "array", length: 2 }, fullItems: 2 });
  });

  it("captures the frame the breakpoint paused in, with the app's values", () => {
    test = createBreakpoints();
    const module = loadCheckout();
    test.apply(entry("bp-1"));

    module.total(TWO_ITEMS);

    const frame = test.snapshots[0]?.stack[0];

    expect({
      function: frame?.function,
      isFixture: frame?.file.endsWith(test.fixtures.file("orders/checkout.cjs")),
      line: frame?.line,
      column: frame?.column,
      sum: variable(test.snapshots[0], "sum"),
    }).toEqual({
      function: "total",
      isFixture: true,
      line: RETURN_LINE,
      column: 3,
      sum: { type: "number", value: TOTAL_OF_TWO_ITEMS },
    });
  });

  it("redacts names with the rules it was given", () => {
    test = createBreakpoints({ isSecret: (name) => name === "sum" });
    const module = loadCheckout();
    test.apply(entry("bp-1"));

    module.total(TWO_ITEMS);

    expect(variable(test.snapshots[0], "sum")).toEqual({ type: "redacted" });
  });

  it("resumes the thread, sends no snapshot and reports the error when the capture throws", () => {
    test = createBreakpoints({
      isSecret: () => {
        throw new Error("rules failed");
      },
    });
    const module = loadCheckout();
    test.apply(entry("bp-1"));

    const total = module.total(TWO_ITEMS);

    expect({
      total,
      resumes: test.session.count("Debugger.resume"),
      snapshots: test.snapshots.length,
      failures: test.failures.map((failure) => (failure as Error).message),
    }).toEqual({ total: TOTAL_OF_TWO_ITEMS, resumes: 1, snapshots: 0, failures: ["rules failed"] });
  });

  it("logs each snapshot at debug with its id, pause time, bytes and truncated, and no captured value", () => {
    test = createBreakpoints();
    const module = loadCheckout();
    test.apply(entry("bp-1"));

    module.total([{ price: 31_337 }]);
    runImmediates();

    expect({
      snapshotLines: test.messagesAt("debug").filter((line) => line.startsWith("snapshot ")),
      valueInLogs: test.lines.some((line) => line.message.includes("31337")),
    }).toEqual({
      snapshotLines: [expect.stringMatching(/^snapshot bp-1: paused \d+\.\d ms, \d+ bytes, truncated false$/)],
      valueInLogs: false,
    });
  });

  it("measures the bytes of the snapshot as sent", () => {
    test = createBreakpoints();
    const module = loadCheckout();
    test.apply(entry("bp-1"));

    module.total(TWO_ITEMS);
    runImmediates();

    const line = test.messagesAt("debug").find((message) => message.startsWith("snapshot "));
    expect(line).toContain(`, ${String(Buffer.byteLength(JSON.stringify(test.snapshots[0])))} bytes,`);
  });
});
