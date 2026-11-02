import type { Message } from "@probex-platform/protocol";
import { hostname } from "node:os";
import { describe, expect, it, vi } from "vitest";

import { useFakeHubs } from "../../../../test/connector/fake-hub.js";
import { createHarness, parseFrame, settle } from "../../../../test/connector/harness.js";
import type { HubConnectorOptions } from "../../options/index.js";
import { SDK_VERSION } from "../../session/version.js";

const TOKEN = "hub-token-1234";
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

describe("HubConnector connect()", () => {
  const hubs = useFakeHubs();

  it("returns without calling a handler, then reports connecting", async () => {
    const hub = await hubs.start();
    const { connector, statuses } = createHarness(hubs, { url: hub.url });

    connector.connect();
    const duringConnect = [...statuses];
    await Promise.resolve();

    expect({ duringConnect, after: statuses }).toEqual({ duringConnect: [], after: ["connecting"] });
  });

  it("opens one connection when called twice", async () => {
    const hub = await hubs.start();
    const { connector, nextStatus } = createHarness(hubs, { url: hub.url });
    const connected = nextStatus("connected");

    connector.connect();
    connector.connect();
    const connection = await hub.nextConnection();
    connection.sendWelcome();
    await connected;

    expect(hub.requests).toHaveLength(1);
  });

  it("reports connected only after the hub's welcome", async () => {
    const hub = await hubs.start();
    const { connector, statuses, nextStatus } = createHarness(hubs, { url: hub.url });
    const connected = nextStatus("connected");
    connector.connect();
    const connection = await hub.nextConnection();
    await connection.nextFrame();
    const beforeWelcome = [...statuses];

    connection.sendWelcome();
    await connected;

    expect({ beforeWelcome, after: statuses }).toEqual({
      beforeWelcome: ["connecting"],
      after: ["connecting", "connected"],
    });
  });

  it("sends a hello as the first frame", async () => {
    const hub = await hubs.start();
    const { connector } = createHarness(hubs, { url: hub.url, service: "checkout", labels: { region: "eu" } });

    connector.connect();
    const frame = await (await hub.nextConnection()).nextFrame();

    expect(parseFrame(frame)).toEqual({
      version: 1,
      type: "hello",
      instanceId: expect.stringMatching(UUID) as unknown,
      service: "checkout",
      labels: { region: "eu" },
      hostname: hostname(),
      pid: process.pid,
      sdk: { name: "@probex-platform/sdk", version: SDK_VERSION },
      runtime: { name: "node", version: process.versions.node },
    });
  });

  it("sends nothing but the hello before welcome", async () => {
    const hub = await hubs.start();
    const { connector, nextStatus } = createHarness(hubs, { url: hub.url });
    const connected = nextStatus("connected");
    connector.connect();
    connector.send({ version: 1, type: "breakpointStatus", breakpointId: "bp-1", status: "active" });
    const connection = await hub.nextConnection();
    await connection.nextFrame();

    connection.sendWelcome();
    await connected;

    expect(connection.frames.map((frame) => parseFrame(frame).type)).toEqual(["hello"]);
  });

  it("keeps the same instanceId across reconnects", async () => {
    const hub = await hubs.start();
    const { connector } = createHarness(hubs, { url: hub.url, reconnect: { minDelayMs: 1, maxDelayMs: 1 } });
    connector.connect();
    const first = await hub.nextConnection();
    const firstHello = await first.nextFrame();
    first.socket.terminate();

    const secondHello = await (await hub.nextConnection()).nextFrame();

    expect(parseFrame(secondHello).instanceId).toBe(parseFrame(firstHello).instanceId);
  });

  it("sends the token as a bearer authorization header", async () => {
    const hub = await hubs.start();
    const { connector } = createHarness(hubs, { url: hub.url, token: TOKEN });

    connector.connect();
    const request = await hub.nextRequest();

    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends no authorization header without a token, even when the URL has userinfo", async () => {
    const hub = await hubs.start();
    const { connector } = createHarness(hubs, { url: hub.url.replace("ws://", "ws://user:password@") });

    connector.connect();
    const request = await hub.nextRequest();

    expect(request.headers.authorization).toBeUndefined();
  });

  it("does not offer compression", async () => {
    const hub = await hubs.start();
    const { connector } = createHarness(hubs, { url: hub.url });

    connector.connect();
    const request = await hub.nextRequest();

    expect(request.headers["sec-websocket-extensions"]).toBeUndefined();
  });

  it("logs a status handler that throws and still calls the others", async () => {
    const hub = await hubs.start();
    const { connector, statuses, messagesAt } = createHarness(hubs, { url: hub.url });
    connector.onStatus(() => {
      throw new Error("status handler failed");
    });
    const later: string[] = [];
    connector.onStatus((status) => later.push(status));

    connector.connect();
    await Promise.resolve();

    expect({ statuses, later, errors: messagesAt("error") }).toEqual({
      statuses: ["connecting"],
      later: ["connecting"],
      errors: ["a status handler threw"],
    });
  });

  it("logs a status handler whose promise rejects, and nothing escapes to the process", async () => {
    const hub = await hubs.start();
    const { connector, messagesAt } = createHarness(hubs, { url: hub.url });
    // An app in plain JavaScript, or one that ignores the type, can pass an async handler
    const asyncHandler = (() => Promise.reject(new Error("async status handler failed"))) as () => void;
    connector.onStatus(asyncHandler);

    connector.connect();
    await settle();

    expect(messagesAt("error")).toEqual(["a status handler threw"]);
  });

  it.each([
    {
      name: "undefined",
      message: undefined,
      lines: { debug: [], error: ["a message that cannot be serialized was dropped"] },
    },
    {
      name: "an object whose type getter throws",
      message: Object.defineProperty({}, "type", {
        get: () => {
          throw Object.assign(new Error("getter failed"), { code: "ERR_TEST_GETTER" });
        },
      }),
      lines: { debug: [], error: ["the connector hit an unexpected error (ERR_TEST_GETTER)"] },
    },
  ])("does not throw from send() with $name", ({ message, lines }) => {
    const { connector, messagesAt } = createHarness(hubs, {});

    // An app in plain JavaScript can pass anything
    connector.send(message as unknown as Message);

    expect({ debug: messagesAt("debug"), error: messagesAt("error") }).toEqual(lines);
  });

  it("stops calling a status handler after its remover runs", async () => {
    const hub = await hubs.start();
    const { connector } = createHarness(hubs, { url: hub.url });
    const seen: string[] = [];
    const remove = connector.onStatus((status) => seen.push(status));

    remove();
    connector.connect();
    await Promise.resolve();

    expect(seen).toEqual([]);
  });
});

describe("HubConnector connect() with an invalid target", () => {
  const hubs = useFakeHubs();

  it.each<{ name: string; options: (port: number) => HubConnectorOptions; error: string }>([
    { name: "no URL", options: () => ({}), error: "no hub URL is set; pass url or set PROBEX_HUB_URL" },
    {
      name: "an http:// URL",
      options: (port) => ({ url: `http://127.0.0.1:${String(port)}/probex` }),
      error: "the hub URL must be a ws:// or wss:// URL",
    },
    {
      name: "a token over ws:// to a host that only resolves to loopback",
      options: (port) => ({ url: `ws://localhost.:${String(port)}/probex`, token: TOKEN }),
      error: "a token is sent over ws:// only to localhost, 127.0.0.0/8 or [::1]; use wss://",
    },
    {
      name: "a token an HTTP header cannot carry",
      options: (port) => ({ url: `ws://127.0.0.1:${String(port)}/probex`, token: "abc\r\nX-Injected: 1" }),
      error: "the token contains characters an HTTP header cannot carry",
    },
  ])("logs an error, stays disconnected and makes no attempt with $name", async ({ options, error }) => {
    vi.stubEnv("PROBEX_HUB_URL", "");
    const hub = await hubs.start();
    const { connector, statuses, messagesAt } = createHarness(hubs, options(hub.port));
    vi.unstubAllEnvs();

    connector.connect();
    await settle();

    expect({ statuses, errors: messagesAt("error"), requests: hub.requests }).toEqual({
      statuses: [],
      errors: [error],
      requests: [],
    });
  });

  it("reads the URL from PROBEX_HUB_URL", async () => {
    const hub = await hubs.start();
    vi.stubEnv("PROBEX_HUB_URL", hub.url);
    const { connector } = createHarness(hubs, {});
    vi.unstubAllEnvs();

    connector.connect();
    const request = await hub.nextRequest();

    expect(request.url).toBe("/probex");
  });
});
