import type { Message } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeHubs, type FakeHub, type HubConnection } from "../../../../test/connector/fake-hub.js";
import {
  advanceToReconnect,
  createHarness,
  parseFrame,
  useConnectorFakeTimers,
  withModules,
  type Harness,
} from "../../../../test/connector/harness.js";

const FLUSH_INTERVAL_MS = 100;

const errorStatus = (breakpointId: string): Message =>
  ({ ...status(breakpointId), module: "errors" }) as unknown as Message;

const status = (breakpointId: string): Message => ({
  version: 1,
  module: "debugger",
  type: "breakpointStatus",
  breakpointId,
  status: "active",
});

const snapshot: Message = {
  version: 1,
  module: "debugger",
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
  const welcome = async (hub: FakeHub, harness: Harness, modules?: string[]): Promise<HubConnection> => {
    const connected = harness.nextStatus("connected");
    const connection = await hub.nextConnection();
    await connection.nextFrame();
    connection.sendWelcome(modules === undefined ? {} : { modules });
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

  describe("by module", () => {
    it("drops what the hub did not accept without a log line and sends the rest", async () => {
      const hub = await hubs.start();
      const harness = createHarness(hubs, withModules(hub.url, ["debugger", "errors"]));
      harness.connector.connect();
      const connection = await welcome(hub, harness, ["errors"]);
      const linesBefore = harness.lines.length;
      harness.connector.send(status("bp-1"));
      harness.connector.send(errorStatus("bp-2"));

      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

      expect({ frame: parseFrame(await connection.nextFrame()), newLines: harness.lines.slice(linesBefore) }).toEqual({
        frame: errorStatus("bp-2"),
        newLines: [],
      });
    });

    it("sends nothing after a welcome with no modules, and still reaches connected", async () => {
      const hub = await hubs.start();
      const harness = createHarness(hubs, { url: hub.url });
      harness.connector.send(status("bp-1"));
      harness.connector.connect();
      const connection = await welcome(hub, harness, []);
      harness.connector.send(snapshot);

      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 10);

      expect({ frames: connection.frames.length, statuses: harness.statuses }).toEqual({
        frames: 1,
        statuses: ["connecting", "connected"],
      });
    });

    it("sends a message queued before the welcome when the welcome lists its module", async () => {
      const hub = await hubs.start();
      const harness = createHarness(hubs, withModules(hub.url, ["debugger", "errors"]));
      harness.connector.send(errorStatus("bp-1"));
      harness.connector.connect();
      const connection = await welcome(hub, harness, ["debugger", "errors"]);

      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

      expect(parseFrame(await connection.nextFrame())).toEqual(errorStatus("bp-1"));
    });

    it("keeps a message of a module the first session did not carry for a later session that does", async () => {
      const hub = await hubs.start();
      const harness = createHarness(
        hubs,
        withModules(hub.url, ["debugger", "errors"], { reconnect: { minDelayMs: 1000, maxDelayMs: 1000 } }),
      );
      harness.connector.connect();
      const first = await welcome(hub, harness, ["debugger"]);
      const disconnected = harness.nextStatus("disconnected");
      first.socket.close(1001);
      await disconnected;
      harness.connector.send(errorStatus("bp-1"));
      await advanceToReconnect(harness);
      const second = await welcome(hub, harness, ["errors"]);

      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

      expect(parseFrame(await second.nextFrame())).toEqual(errorStatus("bp-1"));
    });

    it("keeps two statuses of one breakpoint id apart when their modules differ", async () => {
      const hub = await hubs.start();
      const harness = createHarness(hubs, withModules(hub.url, ["debugger", "errors"]));
      harness.connector.connect();
      const connection = await welcome(hub, harness, ["debugger", "errors"]);
      harness.connector.send(status("bp-1"));
      harness.connector.send(errorStatus("bp-1"));

      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

      expect(parseFrame(await connection.nextFrame())).toEqual({
        version: 1,
        type: "batch",
        messages: [status("bp-1"), errorStatus("bp-1")],
      });
    });
  });
});
