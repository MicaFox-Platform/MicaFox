import type { Message, Connector } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import {
  createDebugger,
  createRecordingLogger,
  envOf,
  FakeConnector,
  FakeInspectorBinding,
  type LoggedLine,
} from "../../../test/debugger/fakes.js";
import { MicafoxDebugger, type DebuggerOptions } from "../index.js";

// A message from a buggy custom connector: reading its type throws inside the debugger's handler
const throwingMessage = (): Message =>
  Object.defineProperty({}, "type", {
    get: () => {
      throw new Error("type getter failed");
    },
  }) as Message;

describe("Debugger.run() options", () => {
  it("logs one info line and does nothing when enabled is false", () => {
    const connector = new FakeConnector();
    const { micafox, lines } = createDebugger();
    micafox.configure({ enabled: false, logLevel: "info", connector });

    micafox.run();

    expect({ lines, connects: connector.connectCount }).toEqual({
      lines: [{ level: "info", message: "turned off by enabled or MICAFOX_ENABLED; not started" }],
      connects: 0,
    });
  });

  it("does nothing when MICAFOX_ENABLED is false", () => {
    const connector = new FakeConnector();
    const { micafox } = createDebugger({ env: envOf(["MICAFOX_ENABLED", "false"]) });
    micafox.configure({ connector });

    micafox.run();

    expect(connector.connectCount).toBe(0);
  });

  it("prefers the enabled option over MICAFOX_ENABLED", () => {
    const connector = new FakeConnector();
    const { micafox } = createDebugger({ env: envOf(["MICAFOX_ENABLED", "false"]) });
    micafox.configure({ enabled: true, connector });

    micafox.run();

    expect(connector.connectCount).toBe(1);
  });

  it("warns and starts when MICAFOX_ENABLED is invalid", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger({ env: envOf(["MICAFOX_ENABLED", "False"]) });
    micafox.configure({ connector });

    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["MICAFOX_ENABLED must be true or false; using true"],
      connects: 1,
    });
  });

  it("warns and starts when the enabled option is not a boolean", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ enabled: "no" as unknown as boolean, connector });

    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["enabled must be true or false; using true"],
      connects: 1,
    });
  });

  it("reads MICAFOX_LOG_LEVEL again at run(), after a line was written before it", () => {
    const env: Record<string, string | undefined> = {};
    const { micafox, messagesAt } = createDebugger({ env });
    micafox.configure(42 as DebuggerOptions);
    micafox.configure({ connector: new FakeConnector() });

    env.MICAFOX_LOG_LEVEL = "info";
    micafox.run();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules"]);
  });

  it("keeps the level resolved at run() when MICAFOX_LOG_LEVEL changes while running", async () => {
    const env: Record<string, string | undefined> = envOf(["MICAFOX_LOG_LEVEL", "info"]);
    const { micafox, messagesAt } = createDebugger({ env });
    micafox.configure({ connector: new FakeConnector() });
    micafox.run();

    env.MICAFOX_LOG_LEVEL = "error";
    await micafox.stop();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules", "stopped"]);
  });

  it("reads MICAFOX_ENABLED again at the next run()", async () => {
    const env: Record<string, string | undefined> = {};
    const connector = new FakeConnector();
    const { micafox } = createDebugger({ env });
    micafox.configure({ connector });
    micafox.run();
    await micafox.stop();

    env.MICAFOX_ENABLED = "false";
    micafox.run();

    expect(connector.connectCount).toBe(1);
  });

  it("warns that the hub options are ignored when a custom connector is set", () => {
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ url: "wss://hub.example.com", labels: { team: "payments" }, connector: new FakeConnector() });

    micafox.run();

    expect(messagesAt("warn")).toEqual(["url, labels ignored: a custom connector is set"]);
  });
});

describe("Debugger.run() refusals", () => {
  it("warns and does nothing when the inspector is already open", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger({ inspectorUrl: () => "ws://127.0.0.1:9229/4f6a" });
    micafox.configure({ connector });

    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["the inspector is already open (--inspect or inspector.open()); not started"],
      connects: 0,
    });
  });

  it("warns and does nothing in a worker thread", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger({ isMainThread: false });
    micafox.configure({ connector });

    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["run() in a worker thread does nothing; MicaFox debugs the main thread only"],
      connects: 0,
    });
  });

  it("logs an error and does not start without a connector or a hub URL", () => {
    const { micafox, binding, lines } = createDebugger();

    micafox.run();

    expect({ lines, isConnected: binding.isConnected }).toEqual({
      lines: [{ level: "error", message: "no hub URL: set url or MICAFOX_HUB_URL, or a connector; not started" }],
      isConnected: false,
    });
  });

  it("logs an error and does not start with a connector that lacks a method", () => {
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector: { connect: () => undefined } as unknown as Connector });

    micafox.run();

    expect(messagesAt("error")).toEqual(["connector is not a Connector; not started"]);
  });
});

describe("Debugger.run() starting", () => {
  it("subscribes, connects and opens the session without enabling the Debugger domain", () => {
    const connector = new FakeConnector();
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector, logLevel: "info" });

    micafox.run();

    expect({
      subscribers: connector.subscriberCount,
      connects: connector.connectCount,
      isConnected: binding.isConnected,
      posted: binding.posted,
      info: messagesAt("info"),
    }).toEqual({
      subscribers: 2,
      connects: 1,
      isConnected: true,
      posted: [],
      info: ["started with a custom connector and 15 redaction rules"],
    });
  });

  it("does nothing when called while running", () => {
    const connector = new FakeConnector();
    const { micafox, lines } = createDebugger();
    micafox.configure({ connector });
    micafox.run();

    micafox.run();

    expect({ connects: connector.connectCount, lines }).toEqual({ connects: 1, lines: [] });
  });

  it("warns and does not start when called while stopping", async () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector });
    micafox.run();
    connector.onUnsubscribe = () => {
      micafox.run();
    };

    await micafox.stop();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: [
        "run() while the debugger is stopping does nothing; call it after stop() resolves",
        "run() while the debugger is stopping does nothing; call it after stop() resolves",
      ],
      connects: 1,
    });
  });
});

describe("Debugger.run() failures", () => {
  it("logs an error, unsubscribes and stays not running when connect() throws", () => {
    const connector = new FakeConnector();
    connector.onConnect = () => {
      throw new Error("connect failed");
    };
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector });

    micafox.run();

    expect({
      errors: messagesAt("error"),
      subscribers: connector.subscriberCount,
      isConnected: binding.isConnected,
    }).toEqual({ errors: ["could not start; not started"], subscribers: 0, isConnected: false });
  });

  it("logs an error and unsubscribes when the inspector session cannot connect", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger({}, new FakeInspectorBinding(new Error("inspector unavailable")));
    micafox.configure({ connector });

    micafox.run();

    expect({ errors: messagesAt("error"), subscribers: connector.subscriberCount }).toEqual({
      errors: ["could not start; not started"],
      subscribers: 0,
    });
  });

  it("accepts configure() and run() again after a failed start", () => {
    const failing = new FakeConnector();
    failing.onConnect = () => {
      throw new Error("connect failed");
    };
    const working = new FakeConnector();
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector: failing });
    micafox.run();

    micafox.configure({ connector: working });
    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: working.connectCount, isConnected: binding.isConnected }).toEqual({
      warnings: [],
      connects: 1,
      isConnected: true,
    });
  });

  it("stops without starting when the connector reports closed inside connect()", () => {
    const connector = new FakeConnector();
    connector.onConnect = () => {
      connector.reportStatus("closed");
    };
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector, logLevel: "info" });

    micafox.run();

    expect({ info: messagesAt("info"), isConnected: binding.isConnected }).toEqual({
      info: ["stopped"],
      isConnected: false,
    });
  });
});

describe("Debugger while running", () => {
  it("warns and stops itself when a custom connector reports closed", () => {
    const connector = new FakeConnector();
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector, logLevel: "info" });
    micafox.run();

    connector.reportStatus("closed");

    expect({
      warnings: messagesAt("warn"),
      info: messagesAt("info"),
      isConnected: binding.isConnected,
      closes: connector.closeCount,
    }).toEqual({
      warnings: ["the connector reported closed; stopping"],
      info: ["started with a custom connector and 15 redaction rules", "stopped"],
      isConnected: false,
      closes: 0,
    });
  });

  it("keeps running when the connector reports any other status", () => {
    const connector = new FakeConnector();
    const { micafox, binding, lines } = createDebugger();
    micafox.configure({ connector });
    micafox.run();

    connector.reportStatus("disconnected");

    expect({ lines, isConnected: binding.isConnected }).toEqual({ lines: [], isConnected: true });
  });

  it("logs an unexpected handler error and stops itself without throwing into the caller", () => {
    const connector = new FakeConnector();
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector });
    micafox.run();

    connector.deliver(throwingMessage());

    expect({ errors: messagesAt("error"), isConnected: binding.isConnected }).toEqual({
      errors: ["unexpected error; stopping"],
      isConnected: false,
    });
  });

  it("logs a message it does not handle yet at debug", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector, logLevel: "debug" });
    micafox.run();

    connector.deliver({ version: 1, type: "welcome", modules: ["debugger"] });

    expect(messagesAt("debug")).toEqual(["ignored a welcome message"]);
  });

  it("ignores the handlers of an earlier run when the connector keeps them", async () => {
    const connector = new FakeConnector();
    connector.keepsHandlers = true;
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector });
    micafox.run();
    await micafox.stop();
    micafox.run();

    connector.reportStatus("closed");

    expect(messagesAt("warn")).toEqual(["the connector reported closed; stopping"]);
  });
});

describe("Debugger.run() with an unusual connector", () => {
  it("rejects a connector whose method getter throws without throwing itself", () => {
    const connector = Object.defineProperty(new FakeConnector(), "connect", {
      get: () => {
        throw new Error("getter failed");
      },
    });
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector });

    micafox.run();

    expect(messagesAt("error")).toEqual(["connector is not a Connector; not started"]);
  });

  it("logs an error and unsubscribes when subscribing to messages throws", () => {
    const connector = new FakeConnector();
    connector.onMessage = () => {
      throw new Error("subscribe failed");
    };
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector });

    micafox.run();

    expect({
      errors: messagesAt("error"),
      subscribers: connector.subscriberCount,
      connects: connector.connectCount,
      isConnected: binding.isConnected,
    }).toEqual({ errors: ["could not start; not started"], subscribers: 0, connects: 0, isConnected: false });
  });

  it("stops cleanly when the connector returns no unsubscribe function", async () => {
    const connector = new FakeConnector();
    connector.onStatus = () => undefined as unknown as () => void;
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector, logLevel: "info" });
    micafox.run();

    await micafox.stop();

    expect({ info: messagesAt("info"), isConnected: binding.isConnected }).toEqual({
      info: ["started with a custom connector and 15 redaction rules", "stopped"],
      isConnected: false,
    });
  });

  it("starts and stops on the real inspector and main thread when no dependencies are passed", async () => {
    const lines: LoggedLine[] = [];
    const micafox = new MicafoxDebugger({ env: {}, console: createRecordingLogger(lines) });
    micafox.configure({ connector: new FakeConnector(), logLevel: "info" });
    micafox.run();

    await micafox.stop();

    expect(lines.map((line) => line.message)).toEqual([
      "started with a custom connector and 15 redaction rules",
      "stopped",
    ]);
  });
});

describe("Debugger.run() with an async connector", () => {
  it("logs an error and stops itself when connect() rejects, without an unhandled rejection", async () => {
    const connector = new FakeConnector();
    const rejection = Promise.reject(new Error("hub refused"));
    connector.connect = () => rejection as unknown as undefined;
    const { micafox, binding, messagesAt } = createDebugger();
    micafox.configure({ connector });
    micafox.run();

    await rejection.catch(() => undefined);

    expect({ errors: messagesAt("error"), isConnected: binding.isConnected }).toEqual({
      errors: ["unexpected error; stopping"],
      isConnected: false,
    });
  });

  it("logs an error when an unsubscribe function rejects", async () => {
    const connector = new FakeConnector();
    const rejection = Promise.reject(new Error("already gone"));
    connector.onStatus = () => () => rejection as unknown as undefined;
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector });
    micafox.run();

    await micafox.stop();
    await rejection.catch(() => undefined);

    expect(messagesAt("error")).toEqual(["unsubscribing from the connector failed"]);
  });
});
