import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { useFakeHubs, type HubConnection } from "../../../test/connector/fake-hub.js";
import {
  advanceToReconnect,
  connectFully,
  useConnectorFakeTimers,
  type Harness,
} from "../../../test/connector/harness.js";

const RECONNECT = { minDelayMs: 1000, maxDelayMs: 8000 };
const BREAKPOINTS = '{"version":1,"type":"breakpoints","breakpoints":[]}';

// Lets ws send each ping, and records first a promise of the next `event` on that socket, so a test can wait for
// the hub's answer to reach the connector
const recordAnswers = (event: "ping" | "pong"): Array<Promise<unknown>> => {
  const answers: Array<Promise<unknown>> = [];
  // Read before the spy replaces it, and called with each socket as `this`
  const ping: unknown = Reflect.get(WebSocket.prototype, "ping");
  vi.spyOn(WebSocket.prototype, "ping").mockImplementation(function (this: WebSocket, ...args) {
    answers.push(once(this, event));
    if (typeof ping === "function") {
      Reflect.apply(ping, this, args);
    }
  });
  return answers;
};

describe("HubConnector heartbeat", () => {
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

  const describeConnection = (harness: Harness): { statuses: readonly string[]; warnings: string[] } => ({
    statuses: harness.statuses,
    warnings: harness.messagesAt("warn"),
  });

  // Runs fake time on by `ms` and resolves once the hub has received the ping that sent
  const advanceToPing = async (connection: HubConnection, ms: number): Promise<number> => {
    const pinged = once(connection.socket, "ping");
    await vi.advanceTimersByTimeAsync(ms);
    await pinged;
    return Date.now();
  };

  it("sends a ping every 15 s while connected", async () => {
    const start = Date.now();
    const hub = await hubs.start();
    const { connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });

    const first = await advanceToPing(connection, 15_000);
    const second = await advanceToPing(connection, 15_000);

    expect([first - start, second - start]).toEqual([15_000, 30_000]);
  });

  it("stays connected when the hub answers a ping with a pong only", async () => {
    const pongs = recordAnswers("pong");
    const hub = await hubs.start();
    const { harness } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    await vi.advanceTimersByTimeAsync(15_000);
    await pongs[0];

    await vi.advanceTimersByTimeAsync(10_000);

    expect(describeConnection(harness)).toEqual({ statuses: ["connecting", "connected"], warnings: [] });
  });

  it("stays connected when the hub answers a ping with a message only", async () => {
    const hub = await hubs.start({ autoPong: false });
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    const answered = new Promise<void>((resolve) => {
      harness.connector.onMessage(() => {
        resolve();
      });
    });
    connection.socket.on("ping", () => {
      connection.socket.send(BREAKPOINTS);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await answered;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(describeConnection(harness)).toEqual({ statuses: ["connecting", "connected"], warnings: [] });
  });

  it("stays connected when the hub answers a ping with its own ping only", async () => {
    const hubPings = recordAnswers("ping");
    const hub = await hubs.start({ autoPong: false });
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    connection.socket.on("ping", () => {
      connection.socket.ping();
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await hubPings[0];

    await vi.advanceTimersByTimeAsync(10_000);

    expect(describeConnection(harness)).toEqual({ statuses: ["connecting", "connected"], warnings: [] });
  });

  it("logs a warning, drops the socket and reconnects when the hub sends nothing within 10 s of a ping", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    // A half-open connection: the hub reads nothing more, so it never answers the ping
    connection.socket.pause();
    await vi.advanceTimersByTimeAsync(15_000 + 9999);
    const justBefore = [...harness.statuses];

    await vi.advanceTimersByTimeAsync(1);
    const waitMs = await advanceToReconnect(harness);

    expect({ justBefore, statuses: harness.statuses, warnings: harness.messagesAt("warn"), waitMs }).toEqual({
      justBefore: ["connecting", "connected"],
      statuses: ["connecting", "connected", "disconnected", "connecting"],
      warnings: ["the hub answered no ping within 10 s"],
      waitMs: RECONNECT.minDelayMs,
    });
  });

  it("drops a hub that answers the first ping but not the second, 10 s after the second", async () => {
    const pongs = recordAnswers("pong");
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    await vi.advanceTimersByTimeAsync(15_000);
    await pongs[0];
    connection.socket.pause();
    await vi.advanceTimersByTimeAsync(15_000 + 9999);
    const justBefore = [...harness.statuses];

    await vi.advanceTimersByTimeAsync(1);

    expect({ justBefore, statuses: harness.statuses }).toEqual({
      justBefore: ["connecting", "connected"],
      statuses: ["connecting", "connected", "disconnected"],
    });
  });

  it("logs an error and reconnects without throwing when sending a ping throws", async () => {
    vi.spyOn(WebSocket.prototype, "ping").mockImplementation(() => {
      throw Object.assign(new Error("ping failed"), { code: "ERR_TEST_PING" });
    });
    const hub = await hubs.start();
    const { harness } = await connectFully(hubs, hub, { reconnect: RECONNECT });

    await vi.advanceTimersByTimeAsync(15_000);
    const waitMs = await advanceToReconnect(harness);

    expect({ errors: harness.messagesAt("error"), waitMs }).toEqual({
      errors: ["the connector hit an unexpected error (ERR_TEST_PING)"],
      waitMs: RECONNECT.minDelayMs,
    });
  });

  it("pings only the new connection after a silent hub was dropped", async () => {
    const ping = vi.spyOn(WebSocket.prototype, "ping");
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    connection.socket.pause();
    await vi.advanceTimersByTimeAsync(15_000 + 10_000);
    await advanceToReconnect(harness);
    const reconnected = harness.nextStatus("connected");
    const next = await hub.nextConnection();
    await next.nextFrame();
    next.sendWelcome();
    await reconnected;
    const pingsBefore = ping.mock.calls.length;

    await vi.advanceTimersByTimeAsync(15_000);

    expect(ping.mock.calls.length - pingsBefore).toBe(1);
  });

  it("stops pinging after close()", async () => {
    const ping = vi.spyOn(WebSocket.prototype, "ping");
    const hub = await hubs.start();
    const { harness } = await connectFully(hubs, hub, { reconnect: RECONNECT });

    await harness.connector.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ping).not.toHaveBeenCalled();
  });
});
