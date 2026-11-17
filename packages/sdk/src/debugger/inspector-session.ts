import type { SdkLogger } from "../logger/index.js";

const COMPONENT = "debugger";

/** What `InspectorSession` uses of a `node:inspector` `Session`; tests pass a fake. */
export interface InspectorBinding {
  connect(): void;
  disconnect(): void;
  post(method: string, params: object | undefined, callback: (error: Error | null, result?: object) => void): void;
  on(event: string, listener: (message: InspectorMessage) => void): unknown;
  off(event: string, listener: (message: InspectorMessage) => void): unknown;
}

/** An event of the inspector protocol, as `Session` emits it. */
export interface InspectorMessage {
  method: string;
  params?: unknown;
}

/** The answer to a command, or why there is none; never thrown. */
export type InspectorResult = { ok: true; value: object } | { ok: false; error: Error };

// node:inspector fails with Error objects; anything else is not read, since reading it could throw
const toError = (error: unknown): Error => {
  try {
    if (error instanceof Error) {
      return error;
    }
  } catch {
    // A Proxy whose getPrototypeOf trap throws
  }

  return new Error("the inspector failed with a value that is not an Error");
};

const failed = (error: unknown): InspectorResult => ({ ok: false, error: toError(error) });

// On the main thread, Session answers inside post(); a binding that does not is reported, never waited for
const NO_ANSWER = "the inspector did not answer synchronously";

/**
 * Wraps a `node:inspector` session. On the main thread `post` answers synchronously, also while the thread is
 * paused; failures come back as results and are never thrown.
 */
export class InspectorSession {
  private isConnected = false;

  constructor(
    private readonly logger: SdkLogger,
    private readonly binding: InspectorBinding,
  ) {}

  /** Connects the session; the `Debugger` domain stays off until a command turns it on. */
  connect(): InspectorResult {
    try {
      this.binding.connect();
      this.isConnected = true;
      return { ok: true, value: {} };
    } catch (error) {
      return failed(error);
    }
  }

  /** Sends `method` and returns its answer, or an error when the session is not connected or the command fails. */
  post(method: string, params?: object): InspectorResult {
    let answer: InspectorResult = { ok: false, error: new Error(NO_ANSWER) };
    try {
      this.binding.post(method, params, (error, result) => {
        answer = error === null ? { ok: true, value: result ?? {} } : failed(error);
      });
    } catch (error) {
      return failed(error);
    }

    return answer;
  }

  /** Calls `handler` with the params of every `event`, such as `Debugger.paused`; returns a function that stops it. */
  on(event: string, handler: (params: unknown) => void): () => void {
    const listener = (message: InspectorMessage): void => {
      try {
        handler(message.params);
      } catch (error) {
        this.logger.log("error", `a handler of ${event} threw`, { component: COMPONENT, error });
      }
    };

    try {
      this.binding.on(event, listener);
    } catch (error) {
      this.logger.log("error", `could not subscribe to ${event}`, { component: COMPONENT, error });
    }

    return () => {
      try {
        this.binding.off(event, listener);
      } catch {
        // Removing a listener of an EventEmitter cannot fail; a binding that throws has nothing left to remove
      }
    };
  }

  /** Disconnects the session; a second call, or one before `connect()`, does nothing. */
  disconnect(): void {
    if (!this.isConnected) {
      return;
    }

    this.isConnected = false;
    try {
      this.binding.disconnect();
    } catch (error) {
      this.logger.log("warn", "the inspector session did not disconnect cleanly", { component: COMPONENT, error });
    }
  }
}
