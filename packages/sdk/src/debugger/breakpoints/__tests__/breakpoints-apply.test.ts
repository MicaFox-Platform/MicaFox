import type { BreakpointStatus } from "@probex-platform/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";

let test: BreakpointsUnderTest;

beforeEach(() => {
  test = createBreakpoints();
});

afterEach(() => {
  test.dispose();
});

const statusOf = (breakpointId: string): BreakpointStatus | undefined =>
  test.sent.findLast((sent) => sent.breakpointId === breakpointId);

const entryAt = (id: string, line: number, limits?: object): object => ({
  id,
  file: test.fixtures.file("orders/checkout.cjs"),
  line,
  ...(limits === undefined ? {} : { limits }),
});

describe("Breakpoints Debugger domain", () => {
  it("makes no Debugger call before the first non-empty list", () => {
    test.apply();
    test.apply();

    expect(test.session.methods).toEqual([]);
  });

  it("turns the domain on with the first non-empty list and off with an empty one", () => {
    test.apply(entryAt("bp-1", 4));
    test.apply(entryAt("bp-1", 4), entryAt("bp-2", 6));
    test.apply();
    test.apply();

    expect({ methods: test.session.methods, debug: test.messagesAt("debug") }).toEqual({
      methods: ["Debugger.enable", "Debugger.disable"],
      debug: ["Debugger domain on", "Debugger domain off"],
    });
  });

  it("keeps the domain off for a list whose entries are all invalid and sends their errors", () => {
    test.apply({ id: "bp-1", file: "", line: 1 });

    expect({ methods: test.session.methods, statuses: test.sent.map((sent) => sent.status) }).toEqual({
      methods: [],
      statuses: ["error"],
    });
  });

  it("turns the domain off when the only valid entry becomes invalid", () => {
    test.apply(entryAt("bp-1", 4));

    test.apply({ ...entryAt("bp-1", 4), line: 0 });

    expect(test.session.methods).toEqual(["Debugger.enable", "Debugger.disable"]);
  });

  it("keeps the domain off for a list whose entries are all ignored", () => {
    test.apply({ file: "a.js", line: 1 }, null);

    expect(test.session.methods).toEqual([]);
  });

  it("finds the scripts again after an empty list turned the domain off", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply(entryAt("bp-1", 4));
    test.apply();

    test.apply(entryAt("bp-1", 4));
    module.total(TWO_ITEMS);

    expect({ statuses: test.sent.map((sent) => sent.status), pauses: test.session.pauses.length }).toEqual({
      statuses: ["active", "active"],
      pauses: 2,
    });
  });

  it("warns when the inspector cannot turn the domain off and keeps it on for the next list", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply(entryAt("bp-1", 4));
    test.session.failing.add("Debugger.disable");
    test.apply();
    test.session.failing.delete("Debugger.disable");

    test.apply(entryAt("bp-1", 4));
    module.total(TWO_ITEMS);

    expect({
      warnings: test.messagesAt("warn"),
      enables: test.session.count("Debugger.enable"),
      statuses: test.sent.map((sent) => sent.status),
      pauses: test.session.pauses.length,
    }).toEqual({
      warnings: ["the inspector could not turn the Debugger domain off"],
      enables: 1,
      statuses: ["active", "active"],
      pauses: 2,
    });
  });

  it("fails and reports when the inspector cannot turn the domain on", () => {
    test.session.failing.add("Debugger.enable");

    expect(() => {
      test.apply(entryAt("bp-1", 4));
    }).toThrow("the inspector could not turn the Debugger domain on");
  });
});

describe("Breakpoints comparing lists", () => {
  it("makes no V8 call for an entry with the same id, file, line and limits and sends its status again", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply(entryAt("bp-1", 4, { maxDepth: 2 }));
    const calls = test.session.posted.length;

    test.apply(entryAt("bp-1", 4, { maxDepth: 2 }));

    expect({ newCalls: test.session.posted.length - calls, statuses: test.sent.map((sent) => sent.status) }).toEqual({
      newCalls: 0,
      statuses: ["active", "active"],
    });
  });

  it.each([
    ["line", (id: string) => entryAt(id, 6)],
    ["limits", (id: string) => entryAt(id, 4, { maxItems: 3 })],
    ["file", (id: string) => ({ id, file: test.fixtures.file("billing/checkout.cjs"), line: 4 })],
  ])("removes a V8 breakpoint and resolves the entry again when its %s changed", (_field, changed) => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.fixtures.loadCheckout(test.fixtures.write("billing/checkout.cjs", CHECKOUT_SOURCE));
    test.apply(entryAt("bp-1", 4));

    test.apply(changed("bp-1"));

    expect({
      set: test.session.count("Debugger.setBreakpointByUrl"),
      removed: test.session.count("Debugger.removeBreakpoint"),
      status: statusOf("bp-1")?.status,
    }).toEqual({ set: 2, removed: 1, status: "active" });
  });

  it("pauses only at the new line after the line of an entry changed", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply(entryAt("bp-1", 4));

    test.apply(entryAt("bp-1", 6));
    module.total(TWO_ITEMS);

    expect(test.session.pauses.length).toBe(1);
  });

  it("removes the V8 breakpoint of an entry missing from the list and sends no status for it", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply(entryAt("bp-1", 4), entryAt("bp-2", 6));
    const sentBefore = test.sent.length;

    test.apply(entryAt("bp-2", 6));
    module.total(TWO_ITEMS);

    expect({
      removed: test.session.count("Debugger.removeBreakpoint"),
      statusIds: test.sent.slice(sentBefore).map((sent) => sent.breakpointId),
      pauses: test.session.pauses.length,
    }).toEqual({ removed: 1, statusIds: ["bp-2"], pauses: 1 });
  });

  it("sends the statuses of a list in its order", () => {
    test.apply(entryAt("bp-2", 4), entryAt("bp-1", 4), { id: "bp-3", file: "", line: 1 });

    expect(test.sent.map((sent) => [sent.breakpointId, sent.status])).toEqual([
      ["bp-2", "pending"],
      ["bp-1", "pending"],
      ["bp-3", "error"],
    ]);
  });

  it("sends error with a message for an invalid entry and replaces it when it is fixed", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply({ ...entryAt("bp-1", 4), line: 0 });

    test.apply(entryAt("bp-1", 4));

    expect(test.sent).toEqual([
      {
        version: 1,
        type: "breakpointStatus",
        breakpointId: "bp-1",
        status: "error",
        message: "line must be a positive integer",
      },
      { version: 1, type: "breakpointStatus", breakpointId: "bp-1", status: "active" },
    ]);
  });
});

describe("Breakpoints reading a message", () => {
  it("ignores entries without a string id and repeats of an id with warnings and no status", () => {
    test.apply({ file: "a.js", line: 1 }, entryAt("bp-1", 4), entryAt("bp-1", 6));

    expect({ ids: test.sent.map((sent) => sent.breakpointId), warnings: test.messagesAt("warn") }).toEqual({
      ids: ["bp-1"],
      warnings: ["1 breakpoint without a string id ignored", "1 repeated id ignored; the first entry of an id is used"],
    });
  });

  it("warns once and ignores the entries after the 200th", () => {
    const entries = Array.from({ length: 201 }, (_, index) => entryAt(`bp-${String(index)}`, 4));

    test.apply(...entries);

    expect({ sent: test.sent.length, warnings: test.messagesAt("warn") }).toEqual({
      sent: 200,
      warnings: ["only the first 200 breakpoints are read; the other 1 are ignored"],
    });
  });

  it("gives every entry after the 100th an error", () => {
    const entries = Array.from({ length: 101 }, (_, index) => entryAt(`bp-${String(index)}`, 4));

    test.apply(...entries);

    expect(statusOf("bp-100")).toEqual({
      version: 1,
      type: "breakpointStatus",
      breakpointId: "bp-100",
      status: "error",
      message: "at most 100 breakpoints are set",
    });
  });

  it("warns and changes nothing when breakpoints is not an array", () => {
    test.apply(entryAt("bp-1", 4));

    test.breakpoints.apply({ version: 1, type: "breakpoints", breakpoints: "bp-1" });

    expect({ sent: test.sent.length, calls: test.session.methods, warnings: test.messagesAt("warn") }).toEqual({
      sent: 1,
      calls: ["Debugger.enable"],
      warnings: ["breakpoints must be an array; the list was ignored"],
    });
  });

  it("logs at info how many breakpoints of the list are active, pending and in error", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const missing = { id: "bp-2", file: test.fixtures.file("orders/invoice.cjs"), line: 1 };

    test.apply(entryAt("bp-1", 4), missing, { id: "bp-3", file: "", line: 1 }, entryAt("bp-4", 100));

    expect(test.messagesAt("info")).toEqual(["1 active, 1 pending, 2 error"]);
  });
});
