import type { Message } from "@probex-platform/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeHubs, type FakeHub, type HubConnection } from "../../../../test/connector/fake-hub.js";
import {
  advanceToReconnect,
  createHarness,
  parseFrame,
  useConnectorFakeTimers,
  type Harness,
} from "../../../../test/connector/harness.js";

const FLUSH_INTERVAL_MS = 100;

const status = (breakpointId: string): Message => ({
  version: 1,
  type: "breakpointStatus",
  breakpointId,
  status: "active",
});

const snapshot: Message = {
  version: 1,
  type: "snapshot",
  breakpointId: "bp-1",
  time: 1_767_225_600_000,
  stack: [{ function: "checkout", file: "src/orders/checkout.ts", line: 42, column: 7 }],
  variables: [{ name: "total", value: { type: "number", value: 99 } }],
};

describe("HubConnector send()", () => {
  const hubs = useFakeHubs();

  beforeEach(() => {
    useConnectorFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Connects, answers the hello with a welcome and waits for `connected`
  const welcome = async (hub: FakeHub, harness: Harness): Promise<HubConnection> => {
    const connected = harness.nextStatus("connected");
    const connection = await hub.nextConnection();
    await connection.nextFrame();
    connection.sendWelcome();
    await connected;
    return connection;
  };

  it("sends a message queued before welcome after it, as itself", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url });
    harness.connector.send(status("bp-1"));
    harness.connector.connect();
    const connection = await welcome(hub, harness);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(parseFrame(await connection.nextFrame())).toEqual(status("bp-1"));
  });

  it("sends several messages as one batch frame, control first", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url });
    harness.connector.connect();
    const connection = await welcome(hub, harness);
    harness.connector.send(snapshot);
    harness.connector.send(status("bp-1"));

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(parseFrame(await connection.nextFrame())).toEqual({
      version: 1,
      type: "batch",
      messages: [status("bp-1"), snapshot],
    });
  });

  it("keeps a message that waits for its batch when the hub closes the connection, and sends it after the next welcome", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url, reconnect: { minDelayMs: 1000, maxDelayMs: 1000 } });
    harness.connector.connect();
    const first = await welcome(hub, harness);
    harness.connector.send(status("bp-1"));
    const disconnected = harness.nextStatus("disconnected");
    first.socket.close(1001);
    await disconnected;
    await advanceToReconnect(harness);
    const second = await welcome(hub, harness);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect({ first: first.frames.length, second: parseFrame(await second.nextFrame()) }).toEqual({
      first: 1,
      second: status("bp-1"),
    });
  });

  it("keeps queued messages across a reconnect and never resends one the socket already took", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url, reconnect: { minDelayMs: 1000, maxDelayMs: 1000 } });
    harness.connector.connect();
    const first = await welcome(hub, harness);
    harness.connector.send(status("bp-1"));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await first.nextFrame();
    const disconnected = harness.nextStatus("disconnected");
    first.socket.terminate();
    await disconnected;
    harness.connector.send(status("bp-2"));
    await advanceToReconnect(harness);
    const second = await welcome(hub, harness);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    await second.nextFrame();
    expect(second.frames.map((frame) => parseFrame(frame))).toEqual([
      expect.objectContaining({ type: "hello" }),
      status("bp-2"),
    ]);
  });
});
