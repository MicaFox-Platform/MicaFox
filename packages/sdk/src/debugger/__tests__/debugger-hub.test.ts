import type { Connector } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import { createDebugger, envOf, FakeConnector, FakeInspectorBinding } from "../../../test/debugger/fakes.js";
import type { HubConnectorOptions } from "../../connector/index.js";

// The connector `run()` creates is a fake, so what the debugger passes and does with it shows without a network
const createHub = (): {
  hub: FakeConnector;
  created: HubConnectorOptions[];
  createHubConnector: (options: HubConnectorOptions) => Connector;
} => {
  const hub = new FakeConnector();
  const created: HubConnectorOptions[] = [];
  return {
    hub,
    created,
    createHubConnector: (options) => {
      created.push(options);
      return hub;
    },
  };
};

const LOGGER_KEY = Symbol.for("micafox.logger");
const MODULES_KEY = Symbol.for("micafox.modules");

describe("Debugger.run() with the default connector", () => {
  it("creates a HubConnector from the hub options and connects it", () => {
    const { hub, created, createHubConnector } = createHub();
    const { micafox } = createDebugger({ createHubConnector });
    micafox.configure({
      url: "wss://hub.example.com/micafox",
      token: "token-1",
      service: "checkout",
      labels: { region: "eu" },
      hubConnector: { closeTimeoutMs: 1000, batch: { flushIntervalMs: 250 } },
    });

    micafox.run();

    expect({ created, connects: hub.connectCount }).toEqual({
      created: [
        {
          url: "wss://hub.example.com/micafox",
          token: "token-1",
          service: "checkout",
          labels: { region: "eu" },
          closeTimeoutMs: 1000,
          batch: { flushIntervalMs: 250 },
          [LOGGER_KEY]: expect.anything() as unknown,
          [MODULES_KEY]: ["debugger"],
        },
      ],
      connects: 1,
    });
  });

  it("passes the debugger's own logger, so one logger serves both", () => {
    const { created, createHubConnector } = createHub();
    const { micafox, lines } = createDebugger({ createHubConnector });
    micafox.configure({ url: "wss://hub.example.com/micafox", logLevel: "info" });
    micafox.run();
    const handed = Reflect.get(created[0] ?? {}, LOGGER_KEY) as { log: (...args: unknown[]) => void };

    handed.log("warn", "written through the handed logger", { component: "debugger" });

    expect(lines).toContainEqual({ level: "warn", message: "written through the handed logger" });
  });

  it("passes only the tuning fields of hubConnector, so it cannot override the hub fields or the logger", () => {
    const { created, createHubConnector } = createHub();
    const { micafox } = createDebugger({ createHubConnector });
    // Plain JavaScript can put anything into the group; the types forbid it
    const hubConnector = Object.assign({ closeTimeoutMs: 1000 }, { url: "wss://other.example.com", logger: console });
    micafox.configure({ url: "wss://hub.example.com/micafox", hubConnector });

    micafox.run();

    expect({ url: created[0]?.url, hasLogger: created[0] !== undefined && "logger" in created[0] }).toEqual({
      url: "wss://hub.example.com/micafox",
      hasLogger: false,
    });
  });

  it("warns and uses the defaults when hubConnector is not an object", () => {
    const { created, createHubConnector } = createHub();
    const { micafox, messagesAt } = createDebugger({ createHubConnector });
    micafox.configure({ url: "wss://hub.example.com/micafox", hubConnector: 5 as never });

    micafox.run();

    expect({ warnings: messagesAt("warn"), created: created.length }).toEqual({
      warnings: ["hubConnector must be an object; using its defaults"],
      created: 1,
    });
  });

  it("skips a hubConnector field whose getter throws, with a warning, and starts", () => {
    const { created, createHubConnector } = createHub();
    const { micafox, messagesAt } = createDebugger({ createHubConnector });
    const hubConnector = Object.defineProperty({ closeTimeoutMs: 1000 }, "batch", {
      enumerable: true,
      get: () => {
        throw new Error("getter failed");
      },
    });
    micafox.configure({ url: "wss://hub.example.com/micafox", hubConnector });

    micafox.run();

    expect({ warnings: messagesAt("warn"), closeTimeoutMs: created[0]?.closeTimeoutMs }).toEqual({
      warnings: ["hubConnector.batch could not be read; it is ignored"],
      closeTimeoutMs: 1000,
    });
  });

  it.each([
    ["a URL that cannot be parsed", { url: "not a url" }, "the hub URL must be a ws:// or wss:// URL"],
    ["an https URL", { url: "https://hub.example.com/micafox" }, "the hub URL must be a ws:// or wss:// URL"],
    [
      "a token over ws:// to another host",
      { url: "ws://hub.internal/micafox", token: "token-1" },
      "a token is sent over ws:// only to localhost, 127.0.0.0/8 or [::1]; use wss://",
    ],
  ])("logs the connector's reason and does not start with %s", (_name, options, reason) => {
    const { created, createHubConnector } = createHub();
    const { micafox, lines, binding } = createDebugger({ createHubConnector });
    micafox.configure(options);

    micafox.run();

    expect({ created: created.length, lines, isConnected: binding.isConnected }).toEqual({
      created: 0,
      lines: [{ level: "error", message: `${reason}; not started` }],
      isConnected: false,
    });
  });

  it("starts with the URL from MICAFOX_HUB_URL", () => {
    const { created, createHubConnector } = createHub();
    const { micafox } = createDebugger({
      createHubConnector,
      env: envOf(["MICAFOX_HUB_URL", "wss://hub.example.com/micafox"]),
    });

    micafox.run();

    expect(created).toHaveLength(1);
  });

  it("starts with an empty url option, which counts as unset, and MICAFOX_HUB_URL", () => {
    const { created, createHubConnector } = createHub();
    const { micafox } = createDebugger({
      createHubConnector,
      env: envOf(["MICAFOX_HUB_URL", "wss://hub.example.com/micafox"]),
    });
    micafox.configure({ url: "" });

    micafox.run();

    expect(created).toHaveLength(1);
  });

  it.each([
    ["no option and no variable", {}, envOf()],
    ["an empty variable", {}, envOf(["MICAFOX_HUB_URL", ""])],
    // The connector ignores an invalid option without falling back to the variable, so the debugger agrees
    ["an invalid option, though the variable is set", { url: 42 }, envOf(["MICAFOX_HUB_URL", "wss://hub.example.com"])],
  ])("logs an error and does not start with %s", (_name, options, env) => {
    const { created, createHubConnector } = createHub();
    const { micafox, lines, binding } = createDebugger({ createHubConnector, env });
    micafox.configure(options as never);

    micafox.run();

    expect({ created: created.length, lines, isConnected: binding.isConnected }).toEqual({
      created: 0,
      lines: [{ level: "error", message: "no hub URL: set url or MICAFOX_HUB_URL, or a connector; not started" }],
      isConnected: false,
    });
  });

  it("uses a custom connector, not a hub one, and warns once about the hub fields", () => {
    const { created, createHubConnector } = createHub();
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger({ createHubConnector });
    micafox.configure({ connector, url: "wss://hub.example.com/micafox", token: "token-1", service: "checkout" });

    micafox.run();

    expect({ created: created.length, connects: connector.connectCount, warnings: messagesAt("warn") }).toEqual({
      created: 0,
      connects: 1,
      warnings: ["url, token, service ignored: a custom connector is set"],
    });
  });
});

describe("Debugger.run() started line", () => {
  it.each([
    [
      "the service and the hub host",
      { url: "wss://hub.example.com:8443/micafox", service: "checkout" },
      "started with the hub connector (service checkout, hub host hub.example.com:8443) and 15 redaction rules",
    ],
    [
      "no service",
      { url: "wss://hub.example.com/micafox" },
      "started with the hub connector (service not set, hub host hub.example.com) and 15 redaction rules",
    ],
  ])("names %s", (_name, options, expected) => {
    const { createHubConnector } = createHub();
    const { micafox, messagesAt } = createDebugger({ createHubConnector });
    micafox.configure({ ...options, logLevel: "info" });

    micafox.run();

    expect(messagesAt("info")).toEqual([expected]);
  });

  it("writes no token, URL credentials or query to any line", async () => {
    const { createHubConnector } = createHub();
    const { micafox, lines } = createDebugger({ createHubConnector });
    micafox.configure({
      url: "wss://user:password-9@hub.example.com/micafox?key=query-9",
      token: "token-9",
      logLevel: "debug",
    });
    micafox.run();
    await micafox.stop();

    const text = JSON.stringify(lines);

    expect({
      hasLines: lines.length > 0,
      token: text.includes("token-9"),
      password: text.includes("password-9"),
      query: text.includes("query-9"),
    }).toEqual({ hasLines: true, token: false, password: false, query: false });
  });
});

describe("Debugger.stop() with the default connector", () => {
  it("waits for the created connector's close() and stays stopping until then", async () => {
    const { hub, createHubConnector } = createHub();
    const closing = Promise.withResolvers<undefined>();
    hub.close = () => closing.promise;
    const { micafox, messagesAt } = createDebugger({ createHubConnector });
    micafox.configure({ url: "wss://hub.example.com/micafox", logLevel: "info" });
    micafox.run();
    let isStopped = false;
    const stopped = micafox.stop().then(() => {
      isStopped = true;
    });
    await Promise.resolve();

    micafox.run();
    const duringClose = { isStopped, warnings: messagesAt("warn") };
    closing.resolve(undefined);
    await stopped;

    expect({ duringClose, isStopped, last: messagesAt("info").at(-1) }).toEqual({
      duringClose: {
        isStopped: false,
        warnings: ["run() while the debugger is stopping does nothing; call it after stop() resolves"],
      },
      isStopped: true,
      last: "stopped",
    });
  });

  it("closes the connector once and unsubscribes from it", async () => {
    const { hub, createHubConnector } = createHub();
    const { micafox } = createDebugger({ createHubConnector });
    micafox.configure({ url: "wss://hub.example.com/micafox" });
    micafox.run();

    await micafox.stop();

    expect({ closes: hub.closeCount, subscribers: hub.subscriberCount }).toEqual({ closes: 1, subscribers: 0 });
  });

  it.each([
    ["rejects", (): Promise<void> => Promise.reject(new Error("close failed"))],
    [
      "throws",
      (): Promise<void> => {
        throw new Error("close failed");
      },
    ],
  ])("logs an error and still resolves when close() %s", async (_name, close) => {
    const { hub, createHubConnector } = createHub();
    hub.close = close;
    const { micafox, messagesAt } = createDebugger({ createHubConnector });
    micafox.configure({ url: "wss://hub.example.com/micafox", logLevel: "info" });
    micafox.run();

    await micafox.stop();

    expect({ errors: messagesAt("error"), last: messagesAt("info").at(-1) }).toEqual({
      errors: ["closing the connector failed"],
      last: "stopped",
    });
  });

  it("can run again after stop() resolves", async () => {
    const { hub, createHubConnector } = createHub();
    const { micafox } = createDebugger({ createHubConnector });
    micafox.configure({ url: "wss://hub.example.com/micafox" });
    micafox.run();
    await micafox.stop();

    micafox.run();

    expect(hub.connectCount).toBe(2);
  });

  it("closes the connector it created when starting fails", async () => {
    const { hub, createHubConnector } = createHub();
    const { micafox, messagesAt } = createDebugger(
      { createHubConnector },
      new FakeInspectorBinding(new Error("no session")),
    );
    micafox.configure({ url: "wss://hub.example.com/micafox" });

    micafox.run();
    await micafox.stop();

    expect({ closes: hub.closeCount, errors: messagesAt("error") }).toEqual({
      closes: 1,
      errors: ["could not start; not started"],
    });
  });
});
