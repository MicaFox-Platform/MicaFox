import type { Message, Connector } from "@probex-platform/protocol";
import { describe, expect, it } from "vitest";

import {
  createDebugger,
  createRecordingLogger,
  envOf,
  FakeConnector,
  FakeInspectorBinding,
  type LoggedLine,
} from "../../../test/debugger/fakes.js";
import { Debugger, type DebuggerOptions } from "../index.js";

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
    const { probex, lines } = createDebugger();
    probex.configure({ enabled: false, logLevel: "info", connector });

    probex.run();

    expect({ lines, connects: connector.connectCount }).toEqual({
      lines: [{ level: "info", message: "turned off by enabled or PROBEX_ENABLED; not started" }],
      connects: 0,
    });
  });

  it("does nothing when PROBEX_ENABLED is false", () => {
    const connector = new FakeConnector();
    const { probex } = createDebugger({ env: envOf(["PROBEX_ENABLED", "false"]) });
    probex.configure({ connector });

    probex.run();

    expect(connector.connectCount).toBe(0);
  });

  it("prefers the enabled option over PROBEX_ENABLED", () => {
    const connector = new FakeConnector();
    const { probex } = createDebugger({ env: envOf(["PROBEX_ENABLED", "false"]) });
    probex.configure({ enabled: true, connector });

    probex.run();

    expect(connector.connectCount).toBe(1);
  });

  it("warns and starts when PROBEX_ENABLED is invalid", () => {
    const connector = new FakeConnector();
    const { probex, messagesAt } = createDebugger({ env: envOf(["PROBEX_ENABLED", "False"]) });
    probex.configure({ connector });

    probex.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["PROBEX_ENABLED must be true or false; using true"],
      connects: 1,
    });
  });

  it("warns and starts when the enabled option is not a boolean", () => {
    const connector = new FakeConnector();
    const { probex, messagesAt } = createDebugger();
    probex.configure({ enabled: "no" as unknown as boolean, connector });

    probex.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["enabled must be true or false; using true"],
      connects: 1,
    });
  });

  it("reads PROBEX_LOG_LEVEL again at run(), after a line was written before it", () => {
    const env: Record<string, string | undefined> = {};
    const { probex, messagesAt } = createDebugger({ env });
    probex.configure(42 as DebuggerOptions);
    probex.configure({ connector: new FakeConnector() });

    env.PROBEX_LOG_LEVEL = "info";
    probex.run();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules"]);
  });

  it("keeps the level resolved at run() when PROBEX_LOG_LEVEL changes while running", async () => {
    const env: Record<string, string | undefined> = envOf(["PROBEX_LOG_LEVEL", "info"]);
    const { probex, messagesAt } = createDebugger({ env });
    probex.configure({ connector: new FakeConnector() });
    probex.run();

    env.PROBEX_LOG_LEVEL = "error";
    await probex.stop();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules", "stopped"]);
  });

  it("reads PROBEX_ENABLED again at the next run()", async () => {
    const env: Record<string, string | undefined> = {};
    const connector = new FakeConnector();
    const { probex } = createDebugger({ env });
    probex.configure({ connector });
    probex.run();
    await probex.stop();

    env.PROBEX_ENABLED = "false";
    probex.run();

    expect(connector.connectCount).toBe(1);
  });

  it("warns that the hub options are ignored when a custom connector is set", () => {
    const { probex, messagesAt } = createDebugger();
    probex.configure({ url: "wss://hub.example.com", labels: { team: "payments" }, connector: new FakeConnector() });

    probex.run();

    expect(messagesAt("warn")).toEqual(["url, labels ignored: a custom connector is set"]);
  });
});

describe("Debugger.run() refusals", () => {
  it("warns and does nothing when the inspector is already open", () => {
    const connector = new FakeConnector();
    const { probex, messagesAt } = createDebugger({ inspectorUrl: () => "ws://127.0.0.1:9229/4f6a" });
    probex.configure({ connector });

    probex.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["the inspector is already open (--inspect or inspector.open()); not started"],
      connects: 0,
    });
  });

  it("warns and does nothing in a worker thread", () => {
    const connector = new FakeConnector();
    const { probex, messagesAt } = createDebugger({ isMainThread: false });
    probex.configure({ connector });

    probex.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["run() in a worker thread does nothing; ProbeX debugs the main thread only"],
      connects: 0,
    });
  });

  it("logs an error and does not start without a connector", () => {
    const { probex, binding, lines } = createDebugger();

    probex.run();

    expect({ lines, isConnected: binding.isConnected }).toEqual({
      lines: [{ level: "error", message: "connector is not set; not started" }],
      isConnected: false,
    });
  });

  it("logs an error and does not start with a connector that lacks a method", () => {
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector: { connect: () => undefined } as unknown as Connector });

    probex.run();

    expect(messagesAt("error")).toEqual(["connector is not a Connector; not started"]);
  });
});

describe("Debugger.run() starting", () => {
  it("subscribes, connects and opens the session without enabling the Debugger domain", () => {
    const connector = new FakeConnector();
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector, logLevel: "info" });

    probex.run();

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
    const { probex, lines } = createDebugger();
    probex.configure({ connector });
    probex.run();

    probex.run();

    expect({ connects: connector.connectCount, lines }).toEqual({ connects: 1, lines: [] });
  });

  it("warns and does not start when called while stopping", async () => {
    const connector = new FakeConnector();
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector });
    probex.run();
    connector.onUnsubscribe = () => {
      probex.run();
    };

    await probex.stop();

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
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector });

    probex.run();

    expect({
      errors: messagesAt("error"),
      subscribers: connector.subscriberCount,
      isConnected: binding.isConnected,
    }).toEqual({ errors: ["could not start; not started"], subscribers: 0, isConnected: false });
  });

  it("logs an error and unsubscribes when the inspector session cannot connect", () => {
    const connector = new FakeConnector();
    const { probex, messagesAt } = createDebugger({}, new FakeInspectorBinding(new Error("inspector unavailable")));
    probex.configure({ connector });

    probex.run();

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
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector: failing });
    probex.run();

    probex.configure({ connector: working });
    probex.run();

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
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector, logLevel: "info" });

    probex.run();

    expect({ info: messagesAt("info"), isConnected: binding.isConnected }).toEqual({
      info: ["stopped"],
      isConnected: false,
    });
  });
});

describe("Debugger while running", () => {
  it("warns and stops itself when a custom connector reports closed", () => {
    const connector = new FakeConnector();
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector, logLevel: "info" });
    probex.run();

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
    const { probex, binding, lines } = createDebugger();
    probex.configure({ connector });
    probex.run();

    connector.reportStatus("disconnected");

    expect({ lines, isConnected: binding.isConnected }).toEqual({ lines: [], isConnected: true });
  });

  it("logs an unexpected handler error and stops itself without throwing into the caller", () => {
    const connector = new FakeConnector();
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector });
    probex.run();

    connector.deliver(throwingMessage());

    expect({ errors: messagesAt("error"), isConnected: binding.isConnected }).toEqual({
      errors: ["unexpected error; stopping"],
      isConnected: false,
    });
  });

  it("logs a message it does not handle yet at debug", () => {
    const connector = new FakeConnector();
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector, logLevel: "debug" });
    probex.run();

    connector.deliver({ version: 1, type: "welcome" });

    expect(messagesAt("debug")).toEqual(["ignored a welcome message"]);
  });

  it("ignores the handlers of an earlier run when the connector keeps them", async () => {
    const connector = new FakeConnector();
    connector.keepsHandlers = true;
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector });
    probex.run();
    await probex.stop();
    probex.run();

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
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector });

    probex.run();

    expect(messagesAt("error")).toEqual(["connector is not a Connector; not started"]);
  });

  it("logs an error and unsubscribes when subscribing to messages throws", () => {
    const connector = new FakeConnector();
    connector.onMessage = () => {
      throw new Error("subscribe failed");
    };
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector });

    probex.run();

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
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector, logLevel: "info" });
    probex.run();

    await probex.stop();

    expect({ info: messagesAt("info"), isConnected: binding.isConnected }).toEqual({
      info: ["started with a custom connector and 15 redaction rules", "stopped"],
      isConnected: false,
    });
  });

  it("starts and stops on the real inspector and main thread when no dependencies are passed", async () => {
    const lines: LoggedLine[] = [];
    const probex = new Debugger({ env: {}, console: createRecordingLogger(lines) });
    probex.configure({ connector: new FakeConnector(), logLevel: "info" });
    probex.run();

    await probex.stop();

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
    const { probex, binding, messagesAt } = createDebugger();
    probex.configure({ connector });
    probex.run();

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
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector });
    probex.run();

    await probex.stop();
    await rejection.catch(() => undefined);

    expect(messagesAt("error")).toEqual(["unsubscribing from the connector failed"]);
  });
});
