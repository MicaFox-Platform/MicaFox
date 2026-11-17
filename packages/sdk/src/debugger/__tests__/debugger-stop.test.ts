import { afterEach, describe, expect, it, vi } from "vitest";

import { createDebugger, FakeConnector } from "../../../test/debugger/fakes.js";
import { SdkLogger } from "../../logger/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Debugger.stop()", () => {
  it("resolves at once and logs nothing when not running", async () => {
    const { micafox, lines } = createDebugger();

    await micafox.stop();

    expect(lines).toEqual([]);
  });

  it("disconnects the session, unsubscribes and leaves a custom connector open", async () => {
    const connector = new FakeConnector();
    const { micafox, binding } = createDebugger();
    micafox.configure({ connector });
    micafox.run();

    await micafox.stop();

    expect({
      isConnected: binding.isConnected,
      subscribers: connector.subscriberCount,
      closes: connector.closeCount,
    }).toEqual({ isConnected: false, subscribers: 0, closes: 0 });
  });

  it("logs stopped at info", async () => {
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector: new FakeConnector(), logLevel: "info" });
    micafox.run();

    await micafox.stop();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules", "stopped"]);
  });

  it("flushes the logger", async () => {
    // The flush writes held lines and repeat summaries the debugger cannot produce yet, so the call is what shows
    const flush = vi.spyOn(SdkLogger.prototype, "flush");
    const { micafox } = createDebugger();
    micafox.configure({ connector: new FakeConnector() });
    micafox.run();

    await micafox.stop();

    expect(flush).toHaveBeenCalledOnce();
  });

  it("returns the same promise when called while stopping", async () => {
    const connector = new FakeConnector();
    const { micafox } = createDebugger();
    micafox.configure({ connector });
    micafox.run();
    const inner: Array<Promise<void>> = [];
    connector.onUnsubscribe = () => {
      inner.push(micafox.stop());
    };

    const outer = micafox.stop();
    await outer;

    expect(inner).toEqual([outer, outer]);
  });

  it("resolves and logs an error when unsubscribing throws", async () => {
    const connector = new FakeConnector();
    connector.onUnsubscribe = () => {
      throw new Error("unsubscribe failed");
    };
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector });
    micafox.run();

    await expect(micafox.stop()).resolves.toBeUndefined();
    expect(messagesAt("error")).toEqual([
      "unsubscribing from the connector failed",
      "unsubscribing from the connector failed",
    ]);
  });

  it("lets run() start the debugger again", async () => {
    const connector = new FakeConnector();
    const { micafox, binding } = createDebugger();
    micafox.configure({ connector });
    micafox.run();
    await micafox.stop();

    micafox.run();

    expect({ connects: connector.connectCount, isConnected: binding.isConnected }).toEqual({
      connects: 2,
      isConnected: true,
    });
  });

  it("never throws or rejects when the app logger throws", async () => {
    const throwing = (): never => {
      throw new Error("logger failed");
    };
    const { micafox } = createDebugger();
    micafox.configure({
      connector: new FakeConnector(),
      logLevel: "debug",
      logger: { debug: throwing, info: throwing, warn: throwing, error: throwing },
    });
    micafox.run();

    await expect(micafox.stop()).resolves.toBeUndefined();
  });
});
