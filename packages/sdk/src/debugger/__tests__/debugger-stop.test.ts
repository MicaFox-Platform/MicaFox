import { afterEach, describe, expect, it, vi } from "vitest";

import { createDebugger, FakeConnector } from "../../../test/debugger/fakes.js";
import { SdkLogger } from "../../logger/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Debugger.stop()", () => {
  it("resolves at once and logs nothing when not running", async () => {
    const { probex, lines } = createDebugger();

    await probex.stop();

    expect(lines).toEqual([]);
  });

  it("disconnects the session, unsubscribes and leaves a custom connector open", async () => {
    const connector = new FakeConnector();
    const { probex, binding } = createDebugger();
    probex.configure({ connector });
    probex.run();

    await probex.stop();

    expect({
      isConnected: binding.isConnected,
      subscribers: connector.subscriberCount,
      closes: connector.closeCount,
    }).toEqual({ isConnected: false, subscribers: 0, closes: 0 });
  });

  it("logs stopped at info", async () => {
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector: new FakeConnector(), logLevel: "info" });
    probex.run();

    await probex.stop();

    expect(messagesAt("info")).toEqual(["started with a custom connector", "stopped"]);
  });

  it("flushes the logger", async () => {
    // The flush writes held lines and repeat summaries the debugger cannot produce yet, so the call is what shows
    const flush = vi.spyOn(SdkLogger.prototype, "flush");
    const { probex } = createDebugger();
    probex.configure({ connector: new FakeConnector() });
    probex.run();

    await probex.stop();

    expect(flush).toHaveBeenCalledOnce();
  });

  it("returns the same promise when called while stopping", async () => {
    const connector = new FakeConnector();
    const { probex } = createDebugger();
    probex.configure({ connector });
    probex.run();
    const inner: Array<Promise<void>> = [];
    connector.onUnsubscribe = () => {
      inner.push(probex.stop());
    };

    const outer = probex.stop();
    await outer;

    expect(inner).toEqual([outer, outer]);
  });

  it("resolves and logs an error when unsubscribing throws", async () => {
    const connector = new FakeConnector();
    connector.onUnsubscribe = () => {
      throw new Error("unsubscribe failed");
    };
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector });
    probex.run();

    await expect(probex.stop()).resolves.toBeUndefined();
    expect(messagesAt("error")).toEqual([
      "unsubscribing from the connector failed",
      "unsubscribing from the connector failed",
    ]);
  });

  it("lets run() start the debugger again", async () => {
    const connector = new FakeConnector();
    const { probex, binding } = createDebugger();
    probex.configure({ connector });
    probex.run();
    await probex.stop();

    probex.run();

    expect({ connects: connector.connectCount, isConnected: binding.isConnected }).toEqual({
      connects: 2,
      isConnected: true,
    });
  });

  it("never throws or rejects when the app logger throws", async () => {
    const throwing = (): never => {
      throw new Error("logger failed");
    };
    const { probex } = createDebugger();
    probex.configure({
      connector: new FakeConnector(),
      logLevel: "debug",
      logger: { debug: throwing, info: throwing, warn: throwing, error: throwing },
    });
    probex.run();

    await expect(probex.stop()).resolves.toBeUndefined();
  });
});
