import type { BreakpointStatus } from "@probex-platform/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  TOTAL_OF_TWO_ITEMS,
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

const status = (breakpointId: string, state: BreakpointStatus["status"], message?: string): BreakpointStatus => ({
  version: 1,
  type: "breakpointStatus",
  breakpointId,
  status: state,
  ...(message === undefined ? {} : { message }),
});

describe("Breakpoints resolving a file", () => {
  it("sets a breakpoint in a script loaded before the list, which pauses at its line", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });
    const total = module.total(TWO_ITEMS);

    expect({ sent: test.sent, total, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "active")],
      total: TOTAL_OF_TWO_ITEMS,
      pauses: 2,
    });
  });

  it("keeps the entry pending until a script with its file name loads, then sends active", () => {
    const file = test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE);
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    const module = test.fixtures.loadCheckout(file);
    const total = module.total(TWO_ITEMS);

    expect({ sent: test.sent, total, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active")],
      total: TOTAL_OF_TWO_ITEMS,
      pauses: 2,
    });
  });

  it("does not send a status again when a script with another file name loads", () => {
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    test.fixtures.loadCheckout(test.fixtures.write("orders/invoice.cjs", CHECKOUT_SOURCE));

    expect(test.sent).toEqual([status("bp-1", "pending")]);
  });

  it("resolves the entry to a script whose path has fewer segments than the file", () => {
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    test.fixtures.loadCheckout(test.fixtures.write("checkout.cjs", CHECKOUT_SOURCE));

    expect(test.sent.map((sent) => sent.status)).toEqual(["pending", "active"]);
  });

  it("does not match a file name that only ends in the entry's name", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/mycheckout.cjs", CHECKOUT_SOURCE));

    test.apply({ id: "bp-1", file: test.fixtures.file("checkout.cjs"), line: 4 });

    expect(test.sent).toEqual([status("bp-1", "pending")]);
  });

  it("hits a script loaded again with the same URL", () => {
    const file = test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE);
    test.fixtures.loadCheckout(file);
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    test.fixtures.unload(file);
    const reloaded = test.fixtures.loadCheckout(file);
    reloaded.total(TWO_ITEMS);

    expect({ sent: test.sent, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "active")],
      pauses: 2,
    });
  });

  it("moves a breakpoint on a line without code to the next line with code", () => {
    const file = test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE);
    const module = test.fixtures.loadCheckout(file);

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 5 });
    module.total(TWO_ITEMS);

    expect({
      debug: test.messagesAt("debug").filter((line) => line.startsWith("bp-1")),
      pauses: test.session.pauses.length,
    }).toEqual({
      debug: [`bp-1 ${test.fixtures.file("orders/checkout.cjs")}:5 → ${test.fixtures.urlOf(file)}:6:3`],
      pauses: 1,
    });
  });

  it("gives error when there is no code at or after the line and removes the V8 breakpoint", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 100 });

    expect({
      sent: test.sent,
      set: test.session.count("Debugger.setBreakpointByUrl"),
      removed: test.session.count("Debugger.removeBreakpoint"),
    }).toEqual({
      sent: [status("bp-1", "error", "no code at or after line 100")],
      set: 1,
      removed: 1,
    });
  });

  it("gives error when the inspector cannot set the breakpoint", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.session.failing.add("Debugger.setBreakpointByUrl");

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    expect(test.sent).toEqual([status("bp-1", "error", "the inspector could not set the breakpoint")]);
  });

  it.each([
    ["no breakpointId", { locations: [] }],
    ["no locations", { breakpointId: "1:3:0:file" }],
  ])("gives error when the inspector answers setBreakpointByUrl with %s", (_name, answer) => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.session.answers.set("Debugger.setBreakpointByUrl", answer);

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    expect(test.sent).toEqual([status("bp-1", "error", "the inspector could not set the breakpoint")]);
  });

  it("gives error and removes the breakpoint when the inspector answers with a malformed location", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.session.answers.set("Debugger.setBreakpointByUrl", { breakpointId: "1:3:0:file", locations: [{}] });

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    expect({ sent: test.sent, removed: test.session.count("Debugger.removeBreakpoint") }).toEqual({
      sent: [status("bp-1", "error", "no code at or after line 4")],
      removed: 1,
    });
  });

  it("picks the script whose path ends with the most segments of the file", () => {
    const orders = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const billing = test.fixtures.loadCheckout(test.fixtures.write("billing/checkout.cjs", CHECKOUT_SOURCE));

    test.apply({ id: "bp-1", file: test.fixtures.file("src/orders/checkout.cjs"), line: 4 });
    billing.total(TWO_ITEMS);
    const billingPauses = test.session.pauses.length;
    orders.total(TWO_ITEMS);

    expect({ sent: test.sent, billingPauses, ordersPauses: test.session.pauses.length - billingPauses }).toEqual({
      sent: [status("bp-1", "active")],
      billingPauses: 0,
      ordersPauses: 2,
    });
  });

  it("gives error when several scripts match equally", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.fixtures.loadCheckout(test.fixtures.write("billing/checkout.cjs", CHECKOUT_SOURCE));

    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.cjs"), line: 4 });

    expect(test.sent).toEqual([status("bp-1", "error", "file matches several files")]);
  });

  it("does not use a script with a source map", () => {
    const withMap = `${CHECKOUT_SOURCE}//# sourceMappingURL=data:application/json;base64,e30=\n`;
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", withMap));

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    expect(test.sent).toEqual([status("bp-1", "pending")]);
  });

  it("shares one V8 breakpoint between entries on the same URL and line, removed with the last", () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const entry = { file: test.fixtures.file("orders/checkout.cjs"), line: 4 };
    test.apply({ id: "bp-1", ...entry }, { id: "bp-2", ...entry });
    const afterFirstList = test.session.count("Debugger.setBreakpointByUrl");

    test.apply({ id: "bp-2", ...entry });
    const removedWhileOneIsLeft = test.session.count("Debugger.removeBreakpoint");
    test.apply({ id: "bp-3", file: test.fixtures.file("orders/checkout.cjs"), line: 6 });

    expect({
      set: afterFirstList,
      removedWhileOneIsLeft,
      removedAfterLast: test.session.count("Debugger.removeBreakpoint"),
    }).toEqual({ set: 1, removedWhileOneIsLeft: 0, removedAfterLast: 1 });
  });

  it("pauses once for entries that share a V8 breakpoint", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const entry = { file: test.fixtures.file("orders/checkout.cjs"), line: 6 };
    test.apply({ id: "bp-1", ...entry }, { id: "bp-2", ...entry });

    module.total(TWO_ITEMS);

    expect(test.session.pauses).toHaveLength(1);
  });

  it("logs each resolution at debug as id, file:line → URL:line:column", () => {
    const file = test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE);
    test.fixtures.loadCheckout(file);

    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 6 });

    expect(test.messagesAt("debug")).toContain(
      `bp-1 ${test.fixtures.file("orders/checkout.cjs")}:6 → ${test.fixtures.urlOf(file)}:6:3`,
    );
  });
});
