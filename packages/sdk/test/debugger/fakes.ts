// Fakes for the debugger's boundaries: the connector, node:inspector and the console its logger writes to.

import type { Connector, ConnectorStatus, Message } from "@micafox/protocol";
import { EventEmitter } from "node:events";

import { MicafoxDebugger, type DebuggerDependencies, type InspectorBinding } from "../../src/debugger/index.js";
import type { Logger } from "../../src/logger/index.js";

/** One line the debugger wrote, without the `[micafox] debugger: ` prefix. */
export interface LoggedLine {
  level: keyof Logger;
  message: string;
}

const PREFIX = "[micafox] debugger: ";

/** A logger that records every line; `onLine` runs inside the call, as an app logger would. */
export const createRecordingLogger = (
  lines: LoggedLine[],
  onLine: (line: LoggedLine) => void = () => undefined,
): Logger => {
  const record =
    (level: keyof Logger) =>
    (message: string): void => {
      const line = { level, message: message.replace(PREFIX, "") };
      lines.push(line);
      onLine(line);
    };
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
};

/** A custom connector that records what the debugger did with it and lets the test report statuses and messages. */
export class FakeConnector implements Connector {
  connectCount = 0;
  closeCount = 0;
  /** Every message the debugger sent, in order. */
  readonly sent: Message[] = [];
  /** Runs inside `connect()`, before it returns. */
  onConnect: () => void = () => undefined;
  /** Runs inside `send()`, after it recorded the message; what it returns, `send()` returns, as an async one would. */
  onSend: () => unknown = () => undefined;
  /** Runs inside every unsubscribe call, before it returns. */
  onUnsubscribe: () => void = () => undefined;
  /** A buggy connector: unsubscribing leaves the handler registered. */
  keepsHandlers = false;
  private readonly statusHandlers = new Set<(status: ConnectorStatus) => void>();
  private readonly messageHandlers = new Set<(message: Message) => void>();

  get subscriberCount(): number {
    return this.statusHandlers.size + this.messageHandlers.size;
  }

  connect(): void {
    this.connectCount += 1;
    this.onConnect();
  }

  send(message: Message): void {
    this.sent.push(message);
    // Typed void like Connector.send, yet a custom connector may return a promise
    return this.onSend() as undefined;
  }

  onMessage(handler: (message: Message) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      if (!this.keepsHandlers) {
        this.messageHandlers.delete(handler);
      }
      this.onUnsubscribe();
    };
  }

  onStatus(handler: (status: ConnectorStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      if (!this.keepsHandlers) {
        this.statusHandlers.delete(handler);
      }
      this.onUnsubscribe();
    };
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }

  reportStatus(status: ConnectorStatus): void {
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  deliver(message: Message): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }
}

/** A `node:inspector` session that answers every command with `{}`, or fails to connect with `connectError`. */
export class FakeInspectorBinding extends EventEmitter implements InspectorBinding {
  isConnected = false;
  readonly posted: string[] = [];

  constructor(private readonly connectError?: Error) {
    super();
  }

  connect(): void {
    if (this.connectError !== undefined) {
      throw this.connectError;
    }

    this.isConnected = true;
  }

  disconnect(): void {
    this.isConnected = false;
  }

  post(method: string, _params: object | undefined, callback: (error: Error | null, result?: object) => void): void {
    this.posted.push(method);
    callback(null, {});
  }
}

/** An inspector session for `Breakpoints` that answers every command with `{}` and lets the test emit events. */
export class FakeBreakpointsInspector {
  readonly posted: string[] = [];
  /** Runs inside `post()`, as V8 emits events inside a command. */
  onPost: (method: string) => void = () => undefined;
  private readonly handlers = new Map<string, (params: unknown) => void>();

  post(method: string): { ok: true; value: object } {
    this.posted.push(method);
    this.onPost(method);
    return { ok: true, value: {} };
  }

  on(event: string, handler: (params: unknown) => void): () => void {
    this.handlers.set(event, handler);
    return () => {
      this.handlers.delete(event);
    };
  }

  emit(event: string, params: unknown): void {
    this.handlers.get(event)?.(params);
  }
}

/** A debugger under test, with the lines it wrote to its default console and its fake inspector session. */
export interface DebuggerUnderTest {
  micafox: MicafoxDebugger;
  lines: LoggedLine[];
  binding: FakeInspectorBinding;
  /** The messages written at `level`. */
  messagesAt: (level: keyof Logger) => string[];
}

/** Creates a debugger on a main thread with no inspector open, an empty environment and a recording console. */
export const createDebugger = (
  dependencies: DebuggerDependencies = {},
  binding = new FakeInspectorBinding(),
): DebuggerUnderTest => {
  const lines: LoggedLine[] = [];
  const micafox = new MicafoxDebugger({
    env: {},
    console: createRecordingLogger(lines),
    inspectorUrl: () => undefined,
    isMainThread: true,
    createInspectorBinding: () => binding,
    ...dependencies,
  });
  const messagesAt = (level: keyof Logger): string[] =>
    lines.filter((line) => line.level === level).map((line) => line.message);
  return { micafox, lines, binding, messagesAt };
};

/** Builds an environment; variable names are wire names, which object literal keys cannot spell under the naming rules. */
export const envOf = (...entries: Array<[name: string, value: string]>): Record<string, string | undefined> =>
  Object.fromEntries(entries);
