import { CLOSE_CODES } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { findClosedPort, useFakeHubs, type FakeHub, type HubConnection } from "../../../../test/connector/fake-hub.js";
import {
  advanceToReconnect,
  createHarness,
  useConnectorFakeTimers,
  type Harness,
} from "../../../../test/connector/harness.js";

const RECONNECT = { minDelayMs: 1000, maxDelayMs: 8000 };

describe("HubConnector failures before welcome", () => {
  const hubs = useFakeHubs();

  beforeEach(() => {
    useConnectorFakeTimers();
    // The longest wait of each jitter range, so a wait equals the current delay
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Connects and waits for the hub to receive the hello
  const connectAndHello = async (hub: FakeHub): Promise<{ harness: Harness; connection: HubConnection }> => {
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    harness.connector.connect();
    const connection = await hub.nextConnection();
    await connection.nextFrame();
    return { harness, connection };
  };

  it.each([
    { name: "a message other than welcome", frame: '{"version":1,"type":"breakpoints","breakpoints":[]}' },
    { name: "a frame that is not JSON", frame: "hello hub" },
    { name: "a welcome of another protocol version", frame: '{"version":2,"type":"welcome"}' },
    { name: "a welcome without modules", frame: '{"version":1,"type":"welcome"}' },
    { name: "a welcome whose modules are not an array", frame: '{"version":1,"type":"welcome","modules":"debugger"}' },
  ])("closes with protocolError, logs an error and waits the longest delay after $name", async ({ frame }) => {
    const hub = await hubs.start();
    const { harness, connection } = await connectAndHello(hub);
    const disconnected = harness.nextStatus("disconnected");

    connection.socket.send(frame);
    const closeCode = await connection.closed;
    await disconnected;
    const waitMs = await advanceToReconnect(harness);

    expect({ closeCode, errorCount: harness.messagesAt("error").length, waitMs }).toEqual({
      closeCode: CLOSE_CODES.protocolError,
      errorCount: 1,
      waitMs: RECONNECT.maxDelayMs,
    });
  });

  it("closes with protocolError after a binary frame", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectAndHello(hub);
    const disconnected = harness.nextStatus("disconnected");

    connection.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    const closeCode = await connection.closed;
    await disconnected;

    expect({ closeCode, errors: harness.messagesAt("error") }).toEqual({
      closeCode: CLOSE_CODES.protocolError,
      errors: ["the hub sent a binary frame before welcome"],
    });
  });

  it.each([
    {
      code: CLOSE_CODES.incompatibleVersion,
      error: "the hub does not support this SDK's protocol version (close code 4426)",
    },
    { code: CLOSE_CODES.protocolError, error: "the hub closed the session with a protocol error (close code 4400)" },
  ])("logs an error and waits the longest delay when the hub closes with $code", async ({ code, error }) => {
    const hub = await hubs.start();
    const { harness, connection } = await connectAndHello(hub);
    const disconnected = harness.nextStatus("disconnected");

    connection.socket.close(code);
    await disconnected;
    const waitMs = await advanceToReconnect(harness);

    expect({ errors: harness.messagesAt("error"), waitMs }).toEqual({ errors: [error], waitMs: RECONNECT.maxDelayMs });
  });

  it("logs an error and waits the longest delay when the hub sends a frame over 1 MiB", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectAndHello(hub);
    const disconnected = harness.nextStatus("disconnected");

    connection.socket.send("x".repeat(1_048_577));
    await disconnected;
    const closeCode = await connection.closed;
    const waitMs = await advanceToReconnect(harness);

    expect({ closeCode, errors: harness.messagesAt("error"), waitMs }).toEqual({
      closeCode: 1009,
      errors: ["the hub sent a frame over 1 MiB"],
      waitMs: RECONNECT.maxDelayMs,
    });
  });

  it("logs an error, ends the attempt and reconnects when its own code throws", async () => {
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(() => {
      throw Object.assign(new Error("send failed"), { code: "ERR_TEST_SEND" });
    });
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    const disconnected = harness.nextStatus("disconnected");

    harness.connector.connect();
    await disconnected;
    const waitMs = await advanceToReconnect(harness);

    expect({ errors: harness.messagesAt("error"), waitMs }).toEqual({
      errors: ["the connector hit an unexpected error (ERR_TEST_SEND)"],
      waitMs: RECONNECT.minDelayMs,
    });
  });

  it.each([401, 403])("logs an error and waits the longest delay on HTTP %i", async (status) => {
    const hub = await hubs.start();
    hub.reply = { kind: "status", status, headers: { "WWW-Authenticate": 'Bearer realm="micafox"' } };
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    const disconnected = harness.nextStatus("disconnected");

    harness.connector.connect();
    await disconnected;
    const waitMs = await advanceToReconnect(harness);

    expect({ errors: harness.messagesAt("error"), waitMs }).toEqual({
      errors: [`the hub rejected the token (HTTP ${String(status)}); check MICAFOX_TOKEN`],
      waitMs: RECONNECT.maxDelayMs,
    });
  });

  it("keeps retrying after a rejection", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 401 };
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    const disconnected = harness.nextStatus("disconnected");
    harness.connector.connect();
    await hub.nextRequest();
    await disconnected;

    await advanceToReconnect(harness);
    await hub.nextRequest();

    expect(hub.requests).toHaveLength(2);
  });

  it("logs a warning and reconnects when no welcome comes within 10 s", async () => {
    const hub = await hubs.start();
    const { harness } = await connectAndHello(hub);
    const disconnected = harness.nextStatus("disconnected");

    await vi.advanceTimersByTimeAsync(10_000);
    await disconnected;
    const waitMs = await advanceToReconnect(harness);

    expect({ warnings: harness.messagesAt("warn"), waitMs }).toEqual({
      warnings: ["the hub sent no welcome within 10 s"],
      waitMs: RECONNECT.minDelayMs,
    });
  });

  it("logs a warning and reconnects when the hub is unreachable", async () => {
    const port = await findClosedPort();
    const harness = createHarness(hubs, { url: `ws://127.0.0.1:${String(port)}/micafox`, reconnect: RECONNECT });
    const disconnected = harness.nextStatus("disconnected");

    harness.connector.connect();
    await disconnected;
    const connecting = harness.nextStatus("connecting");
    await advanceToReconnect(harness);
    await connecting;

    expect({ warnings: harness.messagesAt("warn"), statuses: harness.statuses.slice(0, 3) }).toEqual({
      warnings: [`could not connect to the hub at ws://127.0.0.1:${String(port)}/micafox (ECONNREFUSED)`],
      statuses: ["connecting", "disconnected", "connecting"],
    });
  });

  it.each([500, 302])("logs a warning and reconnects on HTTP %i without following it", async (status) => {
    const hub = await hubs.start();
    const elsewhere = await hubs.start();
    hub.reply = { kind: "status", status, headers: { location: elsewhere.url } };
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    const disconnected = harness.nextStatus("disconnected");
    harness.connector.connect();
    await disconnected;

    await advanceToReconnect(harness);
    await hub.nextRequest();

    expect({ warnings: harness.messagesAt("warn"), elsewhere: elsewhere.requests.length }).toEqual({
      warnings: [`the hub answered the WebSocket upgrade with HTTP ${String(status)}`],
      elsewhere: 0,
    });
  });

  it("logs a warning and reconnects when the hub accepts compression it was not offered", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "acceptWithHeaders", headers: { "Sec-WebSocket-Extensions": "permessage-deflate" } };
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    const disconnected = harness.nextStatus("disconnected");

    harness.connector.connect();
    await hub.nextRequest();
    await disconnected;
    await advanceToReconnect(harness);
    await hub.nextRequest();

    expect({ warnings: harness.messagesAt("warn"), requests: hub.requests.length }).toEqual({
      warnings: [`could not connect to the hub at ${hub.url}`],
      requests: 2,
    });
  });

  it("logs a changed cause in full instead of as a repeat", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 503 };
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    harness.connector.connect();
    await failRepeatedly(harness, hub, 1);

    hub.reply = { kind: "status", status: 500 };
    await failRepeatedly(harness, hub, 1);

    expect(harness.messagesAt("warn")).toEqual([
      "the hub answered the WebSocket upgrade with HTTP 503",
      "the hub answered the WebSocket upgrade with HTTP 500",
    ]);
  });

  it("doubles the delay after each failed attempt up to the longest", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 503 };
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    harness.connector.connect();

    const waits = await failRepeatedly(harness, hub, 5);

    expect(waits).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
});

// Measures the wait after each of `count` failed attempts against a hub that refuses every upgrade
const failRepeatedly = async (harness: Harness, hub: FakeHub, count: number): Promise<number[]> => {
  const waits: number[] = [];
  for (let attempt = 0; attempt < count; attempt += 1) {
    const disconnected = harness.nextStatus("disconnected");
    await hub.nextRequest();
    await disconnected;
    waits.push(await advanceToReconnect(harness));
  }

  return waits;
};

describe("HubConnector failures after welcome", () => {
  const hubs = useFakeHubs();

  beforeEach(() => {
    useConnectorFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs a warning, reports disconnected and waits the shortest delay when the socket drops", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 503 };
    const harness = createHarness(hubs, { url: hub.url, reconnect: RECONNECT });
    harness.connector.connect();
    // Two failures raise the delay to 4000 before the hub accepts a session
    await failRepeatedly(harness, hub, 2);
    hub.reply = { kind: "accept" };
    const connection = await hub.nextConnection();
    const connected = harness.nextStatus("connected");
    await connection.nextFrame();
    connection.sendWelcome();
    await connected;
    const disconnected = harness.nextStatus("disconnected");

    connection.socket.terminate();
    await disconnected;
    const statuses = harness.statuses.slice(-3);
    const waitMs = await advanceToReconnect(harness);

    expect({ warning: harness.messagesAt("warn").at(-1), waitMs, statuses }).toEqual({
      warning: "the connection to the hub closed (close code 1006)",
      waitMs: RECONNECT.minDelayMs,
      statuses: ["connecting", "connected", "disconnected"],
    });
  });
});
