import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  DEBUGGER_STATEMENT_SOURCE,
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

describe("Breakpoints.stop()", () => {
  it("removes every V8 breakpoint and posts Debugger.disable, so the app no longer pauses", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const file = test.fixtures.file("orders/checkout.cjs");
    test.apply({ id: "bp-1", file, line: 4 }, { id: "bp-2", file, line: 6 });

    test.breakpoints.stop();
    module.total(TWO_ITEMS);

    expect({ methods: test.session.methods.slice(-3), pauses: test.session.pauses.length }).toEqual({
      methods: ["Debugger.removeBreakpoint", "Debugger.removeBreakpoint", "Debugger.disable"],
      pauses: 0,
    });
  });

  it("still resumes a pause while it removes the breakpoints", () => {
    const pause = test.fixtures.loadPause(test.fixtures.write("pause.cjs", DEBUGGER_STATEMENT_SOURCE));
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });
    test.session.addSafetyNet();
    let returned: number | undefined;
    test.session.beforePost = (method) => {
      if (method === "Debugger.disable") {
        returned = pause.pause();
      }
    };

    test.breakpoints.stop();

    expect({ returned, unhandled: test.session.unhandledPauses }).toEqual({ returned: 1, unhandled: 0 });
  });

  it("posts no Debugger command when no list ever arrived", () => {
    test.breakpoints.stop();

    expect(test.session.methods).toEqual([]);
  });

  it("warns when the inspector cannot remove a breakpoint, and goes on", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });
    test.session.failing.add("Debugger.removeBreakpoint");

    test.breakpoints.stop();
    module.total(TWO_ITEMS);

    expect({
      warnings: test.messagesAt("warn"),
      disables: test.session.count("Debugger.disable"),
      pauses: test.session.pauses.length,
    }).toEqual({ warnings: ["could not remove a breakpoint from the inspector"], disables: 1, pauses: 0 });
  });
});
