import type { Breakpoint, BreakpointStatus, Message } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebugger, FakeConnector } from "../../../test/debugger/fakes.js";
import {
  CHECKOUT_SOURCE,
  Fixtures,
  TOTAL_OF_TWO_ITEMS,
  TWO_ITEMS,
  TracedSession,
} from "../../../test/debugger/real-v8.js";

let fixtures: Fixtures;

beforeEach(() => {
  fixtures = new Fixtures();
});

afterEach(() => {
  fixtures.remove();
  vi.useRealTimers();
});

// The hub's message, as a custom connector delivers it
const breakpointsMessage = (...breakpoints: Breakpoint[]): Message => ({
  version: 1,
  module: "debugger",
  type: "breakpoints",
  breakpoints,
});

const checkoutEntry = (id: string, line: number): Breakpoint => ({
  id,
  file: fixtures.file("orders/checkout.cjs"),
  line,
  expiresInMs: 3_600_000,
});

const statusesOf = (connector: FakeConnector): Array<[string, BreakpointStatus["status"]]> =>
  connector.sent.flatMap((message) =>
    message.type === "breakpointStatus" ? [[message.breakpointId, message.status]] : [],
  );

// A debugger on the real inspector of the test process, running with a custom connector
const runDebugger = (session = new TracedSession()) => {
  const connector = new FakeConnector();
  const test = createDebugger({ createInspectorBinding: () => session });
  test.micafox.configure({ connector });
  test.micafox.run();
  return { ...test, connector, session };
};

describe("Debugger applying breakpoints", () => {
  it("sends the status of each listed breakpoint through the connector", () => {
    fixtures.loadCheckout(fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const { connector, micafox } = runDebugger();

    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 4), checkoutEntry("bp-2", 100)));

    expect(statusesOf(connector)).toEqual([
      ["bp-1", "active"],
      ["bp-2", "error"],
    ]);
    return micafox.stop();
  });

  it("pauses the app at the breakpoint and resumes it", async () => {
    const module = fixtures.loadCheckout(fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const { connector, micafox, session } = runDebugger();
    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 4)));

    const total = module.total(TWO_ITEMS);

    expect({ total, pauses: session.pauses.length }).toEqual({ total: TOTAL_OF_TWO_ITEMS, pauses: 2 });
    await micafox.stop();
  });

  it("makes no Debugger call until the first list arrives", async () => {
    const { micafox, session } = runDebugger();

    await micafox.stop();

    expect(session.methods).toEqual([]);
  });

  it("removes every breakpoint and turns the domain off on stop()", async () => {
    const module = fixtures.loadCheckout(fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const { connector, micafox, session } = runDebugger();
    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 4)));

    await micafox.stop();
    module.total(TWO_ITEMS);

    expect({ methods: session.methods.slice(-2), pauses: session.pauses.length }).toEqual({
      methods: ["Debugger.removeBreakpoint", "Debugger.disable"],
      pauses: 0,
    });
  });

  it("ignores a list that arrives after stop()", async () => {
    const { connector, micafox, session } = runDebugger();
    await micafox.stop();

    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 4)));

    expect({ methods: session.methods, sent: connector.sent }).toEqual({ methods: [], sent: [] });
  });
});

describe("Debugger failing while applying breakpoints", () => {
  it("logs an error, keeps running and sends the rest when the connector throws on send", async () => {
    const { connector, micafox, messagesAt } = runDebugger();
    connector.onSend = () => {
      throw new Error("socket closed");
    };

    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 4), checkoutEntry("bp-2", 4)));

    expect({
      errors: messagesAt("error"),
      sent: connector.sent.length,
      subscribers: connector.subscriberCount,
    }).toEqual({
      errors: ["sending to the connector failed", "sending to the connector failed"],
      sent: 2,
      subscribers: 2,
    });
    await micafox.stop();
  });

  it("logs an error and keeps running when an async connector rejects a send", async () => {
    const { connector, micafox, messagesAt } = runDebugger();
    connector.onSend = () => Promise.reject(new Error("hub unreachable"));

    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 4)));
    await Promise.resolve();

    expect({ errors: messagesAt("error"), subscribers: connector.subscriberCount }).toEqual({
      errors: ["sending to the connector failed"],
      subscribers: 2,
    });
    await micafox.stop();
  });

  it("warns and keeps running when breakpoints is not an array", async () => {
    const { connector, micafox, messagesAt, session } = runDebugger();
    const message: unknown = { version: 1, module: "debugger", type: "breakpoints", breakpoints: "bp-1" };

    // A buggy hub: the connector passes on what it received
    connector.deliver(message as Message);

    expect({ warnings: messagesAt("warn"), methods: session.methods, subscribers: connector.subscriberCount }).toEqual({
      warnings: ["breakpoints must be an array; the list was ignored"],
      methods: [],
      subscribers: 2,
    });
    await micafox.stop();
  });

  it("stops itself and logs an error when the inspector cannot turn the Debugger domain on", () => {
    const session = new TracedSession();
    session.failing.add("Debugger.enable");
    const { connector, messagesAt } = runDebugger(session);

    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 4)));

    expect({ errors: messagesAt("error"), subscribers: connector.subscriberCount }).toEqual({
      errors: ["unexpected error; stopping"],
      subscribers: 0,
    });
  });

  it("stops itself when the pause of a breakpoint cannot be resumed, with the app running again", () => {
    // The error is logged during the pause, so it is written in a setImmediate after the thread resumed
    vi.useFakeTimers();
    const module = fixtures.loadCheckout(fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    const session = new TracedSession();
    const { connector, messagesAt } = runDebugger(session);
    connector.deliver(breakpointsMessage(checkoutEntry("bp-1", 6)));
    session.failing.add("Debugger.resume");

    const total = module.total(TWO_ITEMS);
    vi.advanceTimersByTime(0);

    expect({
      total,
      errors: messagesAt("error"),
      warnings: messagesAt("warn"),
      disables: session.count("Debugger.disable"),
      removes: session.count("Debugger.removeBreakpoint"),
      subscribers: connector.subscriberCount,
    }).toEqual({
      total: TOTAL_OF_TWO_ITEMS,
      errors: ["unexpected error; stopping"],
      warnings: [],
      disables: 1,
      removes: 0,
      subscribers: 0,
    });
  });
});
