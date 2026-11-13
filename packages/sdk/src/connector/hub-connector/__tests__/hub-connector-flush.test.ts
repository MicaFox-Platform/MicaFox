import type { Message } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { useFakeHubs } from "../../../../test/connector/fake-hub.js";
import { connectFully, createHarness, parseFrame, settle, withModules } from "../../../../test/connector/harness.js";
import type { HubConnector } from "../hub-connector.js";

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

const sendStatuses = (connector: HubConnector, count: number): void => {
  for (let index = 1; index <= count; index += 1) {
    connector.send(status(`bp-${String(index)}`));
  }
};

// A status frame is 77 bytes: at 100 bytes per second the first goes at once, the second after 540 ms and the third
// after another 770 ms, past a 1 s close timeout
const PACED = { batch: { maxMessages: 1 }, rateLimit: { bytesPerSecond: 100 } };

describe("HubConnector close() flush", () => {
  const hubs = useFakeHubs();

  beforeEach(() => {
    // `performance` too: the rate limit reads its clock
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends queued messages at once, control first, then closes with 1000 and drops nothing", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { batch: { flushIntervalMs: 60_000 } });
    harness.connector.send(snapshot);
    harness.connector.send(status("bp-1"));

    await harness.connector.close();
    const closeCode = await connection.closed;

    expect({
      received: connection.frames.slice(1).map((frame) => parseFrame(frame)),
      closeCode,
      warnings: harness.messagesAt("warn"),
    }).toEqual({
      received: [{ version: 1, type: "batch", messages: [status("bp-1"), snapshot] }],
      closeCode: 1000,
      warnings: [],
    });
  });

  it("keeps to the rate limit and drops what is left at closeTimeoutMs with one warning", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { ...PACED, closeTimeoutMs: 1000 });
    harness.connector.send(status("bp-1"));
    harness.connector.send(status("bp-2"));
    harness.connector.send(status("bp-3"));

    const closing = harness.connector.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closing;
    const closeCode = await connection.closed;

    expect({
      received: connection.frames.slice(1).map((frame) => parseFrame(frame)),
      closeCode,
      warnings: harness.messagesAt("warn"),
    }).toEqual({
      received: [status("bp-1"), status("bp-2")],
      closeCode: 1000,
      warnings: ["close() dropped 1 queued message it could not send"],
    });
  });

  it("sends what a connected status handler queues before it calls close()", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url, batch: { flushIntervalMs: 60_000 } });
    const closed = harness.nextStatus("closed");
    harness.connector.connect();
    await Promise.resolve();
    // Added once the connector reports connecting, so the next status it sees is connected
    harness.connector.onStatus(() => {
      harness.connector.send(status("bp-1"));
      void harness.connector.close();
    });
    const connection = await hub.nextConnection();
    await connection.nextFrame();

    connection.sendWelcome();
    await closed;

    expect({ received: parseFrame(await connection.nextFrame()), closeCode: await connection.closed }).toEqual({
      received: status("bp-1"),
      closeCode: 1000,
    });
  });

  it("flushes only the messages of the modules the session carries", async () => {
    const hub = await hubs.start();
    const harness = createHarness(
      hubs,
      withModules(hub.url, ["debugger", "errors"], { batch: { flushIntervalMs: 60_000 } }),
    );
    harness.connector.connect();
    const connected = harness.nextStatus("connected");
    const connection = await hub.nextConnection();
    await connection.nextFrame();
    connection.sendWelcome({ modules: ["errors"] });
    await connected;
    harness.connector.send(status("bp-1"));
    harness.connector.send({ ...status("bp-2"), module: "errors" } as unknown as Message);

    await harness.connector.close();

    expect({
      sent: connection.frames.slice(1).map((frame) => parseFrame(frame)),
      warnings: harness.messagesAt("warn"),
    }).toEqual({
      sent: [{ ...status("bp-2"), module: "errors" }],
      warnings: ["the hub did not accept the module debugger; its messages are dropped"],
    });
  });

  it("stops the flush, logs why and drops the rest when the hub drops the connection meanwhile", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { ...PACED, closeTimeoutMs: 60_000 });
    harness.connector.send(status("bp-1"));
    harness.connector.send(status("bp-2"));
    const closing = harness.connector.close();
    await connection.nextFrame();

    connection.socket.terminate();
    await closing;

    expect({ warnings: harness.messagesAt("warn"), statuses: harness.statuses }).toEqual({
      warnings: [
        "the connection to the hub closed (close code 1006)",
        "close() dropped 1 queued message it could not send",
      ],
      statuses: ["connecting", "connected", "closed"],
    });
  });

  it("neither delivers hub messages nor takes new ones while it flushes", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { ...PACED, closeTimeoutMs: 1000 });
    const delivered: Message[] = [];
    harness.connector.onMessage((message) => delivered.push(message));
    harness.connector.send(status("bp-1"));
    harness.connector.send(status("bp-2"));
    const closing = harness.connector.close();
    await connection.nextFrame();

    connection.socket.send('{"version":1,"module":"debugger","type":"breakpoints","breakpoints":[]}');
    harness.connector.send(status("bp-3"));
    await vi.advanceTimersByTimeAsync(1000);
    await closing;
    await connection.closed;

    expect({
      delivered,
      received: connection.frames.slice(1).map((frame) => parseFrame(frame)),
      warnings: harness.messagesAt("warn"),
    }).toEqual({
      delivered: [],
      received: [status("bp-1"), status("bp-2")],
      warnings: ["send() after close() does nothing"],
    });
  });

  it("resolves closeTimeoutMs + 1 s after close() when the hub stops reading", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { ...PACED, closeTimeoutMs: 1000 });
    harness.connector.send(status("bp-1"));
    harness.connector.send(status("bp-2"));
    harness.connector.send(status("bp-3"));
    connection.socket.pause();
    const closed = harness.nextStatus("closed");
    let isResolved = false;
    void harness.connector.close().then(() => {
      isResolved = true;
    });
    await vi.advanceTimersByTimeAsync(1000 + 999);
    await settle();
    const justBefore = isResolved;

    await vi.advanceTimersByTimeAsync(1);
    await closed;

    expect({ justBefore, statuses: harness.statuses }).toEqual({
      justBefore: false,
      statuses: ["connecting", "connected", "closed"],
    });
  });

  it("stops pinging while it flushes", async () => {
    const ping = vi.spyOn(WebSocket.prototype, "ping");
    const hub = await hubs.start();
    // 25 statuses at 100 bytes per second keep the flush going for about 19 s, past the first ping at 15 s
    const { harness } = await connectFully(hubs, hub, { ...PACED, closeTimeoutMs: 30_000 });
    sendStatuses(harness.connector, 25);

    const closing = harness.connector.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await closing;

    expect(ping).not.toHaveBeenCalled();
  });

  it("sends nothing and drops what is queued with one warning when disconnected", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "status", status: 503 };
    const harness = createHarness(hubs, { url: hub.url });
    const disconnected = harness.nextStatus("disconnected");
    harness.connector.connect();
    await disconnected;
    harness.connector.send(status("bp-1"));
    harness.connector.send(snapshot);

    await harness.connector.close();

    expect(harness.messagesAt("warn")).toEqual([
      "the hub answered the WebSocket upgrade with HTTP 503",
      "close() dropped 2 queued messages it could not send",
    ]);
  });

  it("sends nothing and drops what is queued with one warning while the upgrade is unanswered", async () => {
    const hub = await hubs.start();
    hub.reply = { kind: "silent" };
    const harness = createHarness(hubs, { url: hub.url });
    harness.connector.connect();
    await hub.nextRequest();
    harness.connector.send(status("bp-1"));

    await harness.connector.close();
    await hub.nextSilentUpgradeEnded();

    expect({ warnings: harness.messagesAt("warn"), statuses: harness.statuses }).toEqual({
      warnings: ["close() dropped 1 queued message it could not send"],
      statuses: ["connecting", "closed"],
    });
  });

  it("logs an error and closes without waiting for closeTimeoutMs when writing to the socket throws", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { closeTimeoutMs: 60_000 });
    harness.connector.send(status("bp-1"));
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(() => {
      throw Object.assign(new Error("send failed"), { code: "ERR_TEST_SEND" });
    });

    await harness.connector.close();

    expect({
      errors: harness.messagesAt("error"),
      warnings: harness.messagesAt("warn"),
      closeCode: await connection.closed,
      statuses: harness.statuses,
    }).toEqual({
      errors: ["the connector hit an unexpected error (ERR_TEST_SEND)"],
      // The message had left the queue for the failed write, so the error accounts for it
      warnings: [],
      closeCode: 1000,
      statuses: ["connecting", "connected", "closed"],
    });
  });

  it("aborts an open socket the hub has not welcomed instead of closing it with 1000", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: hub.url });
    harness.connector.connect();
    const connection = await hub.nextConnection();
    await connection.nextFrame();
    harness.connector.send(status("bp-1"));

    await harness.connector.close();

    expect({
      closeCode: await connection.closed,
      frames: connection.frames.map((frame) => parseFrame(frame).type),
      warnings: harness.messagesAt("warn"),
    }).toEqual({
      closeCode: 1006,
      frames: ["hello"],
      warnings: ["close() dropped 1 queued message it could not send"],
    });
  });

  it("never calls a handler added once close() has been called", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { ...PACED, closeTimeoutMs: 1000 });
    harness.connector.send(status("bp-1"));
    harness.connector.send(status("bp-2"));
    const closing = harness.connector.close();
    const calls: unknown[] = [];
    harness.connector.onMessage((message) => calls.push(message));
    harness.connector.onStatus((next) => calls.push(next));

    connection.socket.send('{"version":1,"module":"debugger","type":"breakpoints","breakpoints":[]}');
    await vi.advanceTimersByTimeAsync(1000);
    await closing;

    expect({ calls, statuses: harness.statuses }).toEqual({
      calls: [],
      statuses: ["connecting", "connected", "closed"],
    });
  });
});
