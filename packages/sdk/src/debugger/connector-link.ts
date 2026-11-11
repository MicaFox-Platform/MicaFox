import type { Connector, ConnectorStatus, Message } from "@micafox/protocol";

import type { SdkLogger } from "../logger/index.js";

const COMPONENT = "debugger";

/** What the debugger does with what its connector reports. */
export interface ConnectorHandlers {
  onStatus: (status: ConnectorStatus) => void;
  onMessage: (message: Message) => void;
  /** `connect()` returned a promise that rejected. */
  onConnectRejected: (error: unknown) => void;
}

// An `async connect()` fits `connect(): void`, so a returned promise may reject; unhandled, that kills the host app
const catchRejection = (result: unknown, onRejected: (error: unknown) => void): void => {
  if (result === null || (typeof result !== "object" && typeof result !== "function")) {
    return;
  }

  const then: unknown = Reflect.get(result, "then");
  if (typeof then === "function") {
    Reflect.apply(then, result, [undefined, onRejected]);
  }
};

/**
 * The debugger's calls into one connector for one `run()`. A custom connector may be plain JavaScript or async, so
 * a throw reaches the caller, a rejection reaches a handler, and unsubscribing never fails.
 */
export class ConnectorLink {
  private readonly unsubscribes: unknown[] = [];

  constructor(
    private readonly connector: Connector,
    private readonly logger: SdkLogger,
  ) {}

  /** Subscribes `handlers` to the connector's status and messages, then calls `connect()`; may throw. */
  start({ onStatus, onMessage, onConnectRejected }: ConnectorHandlers, isCurrent: () => boolean): void {
    this.unsubscribes.push(this.connector.onStatus(onStatus));
    // A status handler may have stopped the debugger already; that stop logged why
    if (!isCurrent()) {
      return;
    }

    this.unsubscribes.push(this.connector.onMessage(onMessage));
    if (isCurrent()) {
      // Typed void, yet a custom connector may return a promise: read the result as unknown
      const connector: { connect: () => unknown } = this.connector;
      catchRejection(connector.connect(), onConnectRejected);
    }
  }

  /** Sends `message` to the connector; a connector that throws or rejects is logged, never rethrown. */
  send(message: Message): void {
    try {
      // Typed void, yet a custom connector may return a promise: read the result as unknown
      const connector: { send: (message: Message) => unknown } = this.connector;
      catchRejection(connector.send(message), (error) => {
        this.logSendError(error);
      });
    } catch (error) {
      this.logSendError(error);
    }
  }

  /** Removes every handler `start()` added; a custom connector stays open for the app to close. */
  unsubscribe(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      try {
        if (typeof unsubscribe === "function") {
          catchRejection(Reflect.apply(unsubscribe, undefined, []), (error) => {
            this.logUnsubscribeError(error);
          });
        }
      } catch (error) {
        this.logUnsubscribeError(error);
      }
    }
  }

  private logSendError(error: unknown): void {
    this.logger.log("error", "sending to the connector failed", { component: COMPONENT, error });
  }

  private logUnsubscribeError(error: unknown): void {
    this.logger.log("error", "unsubscribing from the connector failed", { component: COMPONENT, error });
  }
}
