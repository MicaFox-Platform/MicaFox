import { afterEach, describe, expect, it, vi } from "vitest";

import { useFakeHubs } from "../../../../test/connector/fake-hub.js";
import {
  advanceToReconnect,
  connectFully,
  createHarness,
  settle,
  useConnectorFakeTimers,
} from "../../../../test/connector/harness.js";

describe("HubConnector close()", () => {
  const hubs = useFakeHubs();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes an open connection with code 1000 and reports closed once", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub);

    await harness.connector.close();

    expect({ closeCode: await connection.closed, statuses: harness.statuses }).toEqual({
      closeCode: 1000,
      statuses: ["connecting", "connected", "closed"],
    });
  });

  it("calls no handler from inside close()", () => {
    const { connector, statuses } = createHarness(hubs, {});

    void connector.close();

    expect(statuses).toEqual([]);
  });

  it("returns the same promise from a second call", () => {
    const { connector } = createHarness(hubs, {});

    const first = connector.close();

    expect(connector.close()).toBe(first);
  });

  it("stops reconnecting", async () => {
    useConnectorFakeTimers();
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 503 };
    const harness = createHarness(hubs, { url: hub.url });
    const disconnected = harness.nextStatus("disconnected");
    harness.connector.connect();
    await hub.nextRequest();
    await disconnected;

    await harness.connector.close();
    await vi.runAllTimersAsync();
    await settle();

    expect({ requests: hub.requests.length, statuses: harness.statuses }).toEqual({
      requests: 1,
      statuses: ["connecting", "disconnected", "closed"],
    });
  });

  it("aborts a connection whose upgrade the hub has not answered yet", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "silent" };
    const harness = createHarness(hubs, { url: hub.url });
    harness.connector.connect();
    await hub.nextRequest();

    await harness.connector.close();
    await hub.nextSilentUpgradeEnded();

    expect(harness.statuses).toEqual(["connecting", "closed"]);
  });

  it("opens no connection when close() follows connect() in the same tick", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url });

    harness.connector.connect();
    await harness.connector.close();
    await settle();

    expect({ requests: hub.requests.length, statuses: harness.statuses }).toEqual({
      requests: 0,
      statuses: ["closed"],
    });
  });

  it("opens no connection when a status handler closes the connector on connecting", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url });
    const closed = harness.nextStatus("closed");
    // The first status a connector reports is connecting
    harness.connector.onStatus(() => {
      void harness.connector.close();
    });

    harness.connector.connect();
    await closed;
    await settle();

    expect({ requests: hub.requests.length, statuses: harness.statuses }).toEqual({
      requests: 0,
      statuses: ["connecting", "closed"],
    });
  });

  it("does not reconnect when a status handler closes the connector on disconnected", async () => {
    useConnectorFakeTimers();
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 503 };
    const harness = createHarness(hubs, { url: hub.url });
    const closed = harness.nextStatus("closed");
    harness.connector.connect();
    await Promise.resolve();
    // Added once the connector reports connecting, so the next status it sees is disconnected
    harness.connector.onStatus(() => {
      void harness.connector.close();
    });

    await closed;
    await vi.runAllTimersAsync();
    await settle();

    expect({ requests: hub.requests.length, statuses: harness.statuses }).toEqual({
      requests: 1,
      statuses: ["connecting", "disconnected", "closed"],
    });
  });

  it("writes the summary of repeated warnings before it resolves", async () => {
    useConnectorFakeTimers();
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 503 };
    const harness = createHarness(hubs, { url: hub.url });
    const firstFailure = harness.nextStatus("disconnected");
    harness.connector.connect();
    await hub.nextRequest();
    await firstFailure;
    await advanceToReconnect(harness);
    const secondFailure = harness.nextStatus("disconnected");
    await hub.nextRequest();
    await secondFailure;

    await harness.connector.close();

    expect(harness.messagesAt("warn")).toEqual([
      "the hub answered the WebSocket upgrade with HTTP 503",
      expect.stringMatching(/^the hub answered the WebSocket upgrade with HTTP 503 \(repeated 1 times in \d+ s\)$/),
    ]);
  });

  it("logs a warning and does nothing on connect() and send() after close()", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url });
    await harness.connector.close();

    harness.connector.connect();
    harness.connector.send({ version: 1, type: "breakpointStatus", breakpointId: "bp-1", status: "active" });
    await settle();

    expect({ warnings: harness.messagesAt("warn"), requests: hub.requests.length }).toEqual({
      warnings: ["connect() after close() does nothing", "send() after close() does nothing"],
      requests: 0,
    });
  });

  it("resolves within 1 s when the hub never answers the closing handshake", async () => {
    useConnectorFakeTimers();
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub);
    // The hub stops reading, so the connector's close frame gets no answer
    connection.socket.pause();

    const closing = harness.connector.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closing;

    expect(harness.statuses.at(-1)).toBe("closed");
  });
});
