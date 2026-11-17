import { CLOSE_CODES, type Breakpoints, type Message } from "@micafox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFakeHubs, type HubConnection } from "../../../../test/connector/fake-hub.js";
import { advanceToReconnect, connectFully, useConnectorFakeTimers } from "../../../../test/connector/harness.js";
import type { HubConnector } from "../hub-connector.js";

const RECONNECT = { minDelayMs: 1000, maxDelayMs: 8000 };

const createBreakpoints = (id: string): Breakpoints => ({
  version: 1,
  module: "debugger",
  type: "breakpoints",
  breakpoints: [{ id, file: "src/orders/checkout.ts", line: 42, expiresInMs: 3_600_000 }],
});

// Subscribes last, so the handlers a test adds run first; resolves with the next `count` messages
const receive = (connector: HubConnector, count = 1): Promise<Message[]> =>
  new Promise((resolve) => {
    const messages: Message[] = [];
    connector.onMessage((message) => {
      messages.push(message);
      if (messages.length === count) {
        resolve(messages);
      }
    });
  });

describe("HubConnector receiving", () => {
  const hubs = useFakeHubs();

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes a message to every handler in the order they subscribed", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    const calls: Array<[string, Message]> = [];
    harness.connector.onMessage((message) => calls.push(["first", message]));
    harness.connector.onMessage((message) => calls.push(["second", message]));
    const received = receive(harness.connector);

    connection.socket.send(JSON.stringify(createBreakpoints("bp-1")));
    await received;

    expect(calls).toEqual([
      ["first", createBreakpoints("bp-1")],
      ["second", createBreakpoints("bp-1")],
    ]);
  });

  it("stops calling a removed handler and does not skip the next one when a handler removes itself", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    const calls: string[] = [];
    const unsubscribe = harness.connector.onMessage(() => {
      calls.push("removes itself");
      unsubscribe();
    });
    harness.connector.onMessage(() => calls.push("stays"));
    const received = receive(harness.connector, 2);

    connection.socket.send(JSON.stringify(createBreakpoints("bp-1")));
    connection.socket.send(JSON.stringify(createBreakpoints("bp-2")));
    await received;

    expect(calls).toEqual(["removes itself", "stays", "stays"]);
  });

  it("still calls the other handlers when a handler calls close()", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    harness.connector.onMessage(() => {
      void harness.connector.close();
    });
    const received = receive(harness.connector);

    connection.socket.send(JSON.stringify(createBreakpoints("bp-1")));

    await expect(received).resolves.toEqual([createBreakpoints("bp-1")]);
  });

  it("logs a handler that throws and still calls the others", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    harness.connector.onMessage(() => {
      throw new Error("handler failed");
    });
    const received = receive(harness.connector);

    connection.socket.send(JSON.stringify(createBreakpoints("bp-1")));

    expect({ messages: await received, errors: harness.messagesAt("error") }).toEqual({
      messages: [createBreakpoints("bp-1")],
      errors: ["a message handler threw"],
    });
  });

  it("passes no message to handlers once a handler has called close()", async () => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    const calls: Message[] = [];
    harness.connector.onMessage((message) => {
      calls.push(message);
      void harness.connector.close();
    });
    const closed = harness.nextStatus("closed");

    connection.socket.send(JSON.stringify(createBreakpoints("bp-1")));
    connection.socket.send(JSON.stringify(createBreakpoints("bp-2")));
    await closed;

    expect(calls).toEqual([createBreakpoints("bp-1")]);
  });

  it.each([
    {
      name: "a binary frame",
      send: (connection: HubConnection) => {
        connection.socket.send(Buffer.from([1, 2, 3]), { binary: true });
      },
      warning: "ignored a binary frame from the hub",
    },
    {
      name: "a message type only the SDK sends",
      send: (connection: HubConnection) => {
        connection.socket.send('{"version":1,"module":"debugger","type":"snapshot","breakpointId":"bp-1"}');
      },
      warning: "ignored a snapshot message from the hub; only the SDK sends it",
    },
    {
      name: "a message without a module",
      send: (connection: HubConnection) => {
        connection.socket.send('{"version":1,"type":"breakpoints","breakpoints":[]}');
      },
      warning: "ignored a message from the hub without a string module",
    },
    {
      name: "a batch from the hub",
      send: (connection: HubConnection) => {
        connection.socket.send('{"version":1,"type":"batch","messages":[]}');
      },
      warning: "ignored a batch message from the hub; only the SDK sends it",
    },
    {
      name: "a hello from the hub",
      send: (connection: HubConnection) => {
        connection.socket.send('{"version":1,"type":"hello"}');
      },
      warning: "ignored a hello message from the hub; only the SDK sends it",
    },
    {
      name: "a frame that is not valid JSON",
      send: (connection: HubConnection) => {
        connection.socket.send("{breakpoints");
      },
      warning: "ignored a frame from the hub that is not valid JSON",
    },
    {
      name: "a message without a numeric version",
      send: (connection: HubConnection) => {
        connection.socket.send('{"type":"breakpoints","breakpoints":[]}');
      },
      warning: "ignored a message from the hub without a numeric version and a string type",
    },
  ])("logs a warning, passes nothing to handlers and stays connected after $name", async ({ send, warning }) => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    const received = receive(harness.connector);

    send(connection);
    connection.socket.send(JSON.stringify(createBreakpoints("bp-1")));

    expect({ messages: await received, warnings: harness.messagesAt("warn"), statuses: harness.statuses }).toEqual({
      messages: [createBreakpoints("bp-1")],
      warnings: [warning],
      statuses: ["connecting", "connected"],
    });
  });

  it.each([
    {
      name: "a later welcome",
      frame: '{"version":1,"type":"welcome","modules":["debugger"]}',
      debug: "ignored a welcome from the hub after the first one",
    },
    {
      name: "an unknown type",
      frame: '{"version":1,"module":"debugger","type":"future"}',
      debug: "ignored a message of an unknown type from the hub",
    },
    {
      name: "a message of a module the session did not agree on",
      frame: '{"version":1,"module":"errors","type":"breakpoints","breakpoints":[]}',
      debug: "ignored a message of a module the session did not agree on",
    },
  ])("logs $name at debug and passes it to no handler", async ({ frame, debug }) => {
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    const received = receive(harness.connector);

    connection.socket.send(frame);
    connection.socket.send(JSON.stringify(createBreakpoints("bp-1")));

    expect({ messages: await received, debug: harness.messagesAt("debug").includes(debug) }).toEqual({
      messages: [createBreakpoints("bp-1")],
      debug: true,
    });
  });

  it("closes with protocolError, logs an error and waits the longest delay after a message of another version", async () => {
    useConnectorFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const hub = await hubs.start();
    const { harness, connection } = await connectFully(hubs, hub, { reconnect: RECONNECT });
    const disconnected = harness.nextStatus("disconnected");

    connection.socket.send('{"version":2,"type":"breakpoints","breakpoints":[]}');
    const closeCode = await connection.closed;
    await disconnected;
    const waitMs = await advanceToReconnect(harness);

    expect({ closeCode, errors: harness.messagesAt("error"), waitMs }).toEqual({
      closeCode: CLOSE_CODES.protocolError,
      errors: ["the hub sent a message of protocol version 2; the session speaks 1"],
      waitMs: RECONNECT.maxDelayMs,
    });
  });
});
