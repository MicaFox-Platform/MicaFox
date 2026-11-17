// Drives one HubConnector in a test: records its status changes and every line it logs, at debug level.

import type { ConnectorStatus } from "@micafox/protocol";
import { vi } from "vitest";

import type { FakeHub, FakeHubs, HubConnection } from "./fake-hub.js";
import { HubConnector, MODULES_KEY, type HubConnectorOptions } from "../../src/connector/index.js";
import type { LogContext, Logger } from "../../src/logger/index.js";

/** One call of the app logger. */
export interface LoggedLine {
  level: keyof Logger;
  message: string;
  context: LogContext;
}

/** A connector under test with what it reported. */
export interface Harness {
  connector: HubConnector;
  statuses: readonly ConnectorStatus[];
  lines: readonly LoggedLine[];
  /** Resolves when `status` is next reported. */
  nextStatus: (status: ConnectorStatus) => Promise<void>;
  /** The messages logged at `level`, without the `[micafox] connector: ` prefix. */
  messagesAt: (level: keyof Logger) => string[];
}

const PREFIX = "[micafox] connector: ";

const createRecordingLogger = (lines: LoggedLine[]): Logger => {
  const record =
    (level: keyof Logger) =>
    (message: string, context: LogContext): void => {
      lines.push({ level, message, context });
    };
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
};

/** Options that make the connector send `modules` in its hello, as the debugger does through the internal key. */
export const withModules = (url: string, modules: unknown, rest: HubConnectorOptions = {}): HubConnectorOptions => {
  // Not an object literal at the call, so the internal key is no excess property
  const options = { ...rest, url, [MODULES_KEY]: modules };
  return options;
};

/** Creates a connector that is closed after the test; its status handler is the first one added. */
export const createHarness = (hubs: FakeHubs, options: HubConnectorOptions): Harness => {
  const statuses: ConnectorStatus[] = [];
  const lines: LoggedLine[] = [];
  const waiters: Array<{ status: ConnectorStatus; resolve: () => void }> = [];
  const connector = hubs.track(
    new HubConnector({ logLevel: "debug", logger: createRecordingLogger(lines), ...options }),
  );
  connector.onStatus((status) => {
    statuses.push(status);
    for (const waiter of waiters.filter((candidate) => candidate.status === status)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });

  return {
    connector,
    statuses,
    lines,
    nextStatus: (status) =>
      new Promise((resolve) => {
        waiters.push({ status, resolve });
      }),
    messagesAt: (level) => lines.filter((line) => line.level === level).map((line) => line.message.replace(PREFIX, "")),
  };
};

/** A connector that has received the hub's welcome, with the hub's side of its connection. */
export interface Connected {
  harness: Harness;
  connection: HubConnection;
}

/** Creates a connector for `hub`, connects it and answers its hello with a welcome. */
export const connectFully = async (
  hubs: FakeHubs,
  hub: FakeHub,
  options: HubConnectorOptions = {},
): Promise<Connected> => {
  const harness = createHarness(hubs, { url: hub.url, ...options });
  const connected = harness.nextStatus("connected");
  harness.connector.connect();
  const connection = await hub.nextConnection();
  await connection.nextFrame();
  connection.sendWelcome();
  await connected;
  return { harness, connection };
};

/** Parses a frame the hub received. */
export const parseFrame = (frame: string): Record<string, unknown> => {
  // The connector only ever sends JSON objects; a test fails on anything else
  return JSON.parse(frame) as Record<string, unknown>;
};

/** Fakes the timers the connector uses, and `Date` so a test can measure a wait in fake time. */
export const useConnectorFakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
};

/** Runs fake time until the disconnected connector of `harness` reconnects, and returns how long it waited. */
export const advanceToReconnect = async (harness: Harness): Promise<number> => {
  const before = Date.now();
  const seen = harness.statuses.length;
  // Timer by timer: ws's own timers, such as its 1 s closing-handshake timer, may still be due before the reconnect
  while (!harness.statuses.slice(seen).includes("connecting")) {
    if (vi.getTimerCount() === 0) {
      throw new Error("no timer left, so the connector never reconnects");
    }

    await vi.advanceTimersToNextTimerAsync();
  }

  return Date.now() - before;
};

/** Lets ws finish what it scheduled with process.nextTick and real I/O callbacks already due. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
