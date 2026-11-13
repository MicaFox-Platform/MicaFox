import type { Connector, ConnectorStatus, Message } from "@micafox/protocol";
import { randomUUID } from "node:crypto";

import { Backoff } from "./backoff.js";
import { HandlerList } from "./handlers.js";
import { readErrorCode, type SdkLogger } from "../../logger/index.js";
import {
  Attempt,
  checkHubTarget,
  type AttemptEvents,
  type AttemptFailure,
  type HubTarget,
} from "../connection/index.js";
import { resolveConnectorConfig, type HubConnectorOptions, type ResolvedConnectorOptions } from "../options/index.js";
import { Batcher } from "../outbound/index.js";
import { buildHello, type ModuleAgreement } from "../session/index.js";

const COMPONENT = "connector";

const doNothing = (): void => {
  // A handler added after close() is never called, so there is nothing to remove
};

/** The default `Connector`: carries protocol messages between the SDK and the hub over one WebSocket. */
export class HubConnector implements Connector {
  private readonly options: ResolvedConnectorOptions;
  private readonly logger: SdkLogger;
  // What `hello` lists, the same on every connection
  private readonly modules: readonly string[];
  // One per connector, the same across reconnects, so the hub can tell a reconnect from a new instance
  private readonly instanceId = randomUUID();
  private readonly backoff: Backoff;
  private readonly statusHandlers: HandlerList<ConnectorStatus>;
  private readonly messageHandlers: HandlerList<Message>;
  private readonly attemptEvents: AttemptEvents;
  private readonly batcher: Batcher;
  private status: ConnectorStatus = "disconnected";
  // The modules the current session carries, from its `welcome`
  private agreedModules: ReadonlySet<string> = new Set();
  private hasStarted = false;
  private target: HubTarget | undefined;
  private attempt: Attempt | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  // Ends the flush of close() early, when the session ends meanwhile
  private endFlush: (() => void) | undefined;

  /** Resolves the options once; does no I/O until `connect()`. */
  constructor(options?: HubConnectorOptions) {
    const { options: resolved, logger, modules } = resolveConnectorConfig(options);
    this.options = resolved;
    this.logger = logger;
    this.modules = modules;
    this.backoff = new Backoff(resolved.reconnect.minDelayMs, resolved.reconnect.maxDelayMs);
    this.statusHandlers = new HandlerList((error) => {
      this.logger.log("error", "a status handler threw", { component: COMPONENT, error });
    });
    this.messageHandlers = new HandlerList((error) => {
      this.logger.log("error", "a message handler threw", { component: COMPONENT, error });
    });
    this.batcher = new Batcher(resolved, {
      logger,
      now: () => performance.now(),
      onInternalError: (error) => {
        this.logInternalError(error);
      },
    });
    this.attemptEvents = {
      onWelcome: (agreement) => {
        this.onWelcome(agreement);
      },
      onMessage: (message) => {
        this.deliver(message);
      },
      onIgnored: ({ level, reason }) => {
        this.log(level, reason, `hub-ignored:${reason}`);
      },
      onEnd: (failure) => {
        this.onAttemptEnd(failure);
      },
    };
  }

  /** Starts connecting in the background and returns at once; a second call does nothing. */
  connect(): void {
    try {
      if (this.isClosing()) {
        this.log("warn", "connect() after close() does nothing", "connect-after-close");
        return;
      }

      if (this.hasStarted) {
        return;
      }

      this.hasStarted = true;
      const check = checkHubTarget(this.options.url, this.options.token);
      if (!check.ok) {
        this.log("error", check.reason, "invalid-hub-target");
        return;
      }

      this.target = check.target;
      // Handlers are never called from inside connect(): the status changes after it returns
      queueMicrotask(() => {
        this.openSafely();
      });
    } catch (error) {
      this.logInternalError(error);
    }
  }

  /** Serializes `message` once and queues it, and returns; it goes out in a batch after the hub's `welcome`. */
  send(message: Message): void {
    try {
      if (this.isClosing()) {
        this.log("warn", "send() after close() does nothing", "send-after-close");
        return;
      }

      this.batcher.enqueue(message);
    } catch (error) {
      this.logInternalError(error);
    }
  }

  /** Adds a handler for messages from the hub; returns a function that removes it. */
  onMessage(handler: (message: Message) => void): () => void {
    return !this.isClosing() ? this.messageHandlers.add(handler) : doNothing;
  }

  /** Adds a handler for status changes; returns a function that removes it. */
  onStatus(handler: (status: ConnectorStatus) => void): () => void {
    return !this.isClosing() ? this.statusHandlers.add(handler) : doNothing;
  }

  /**
   * Stops reconnecting; when connected, sends what is queued for up to `closeTimeoutMs`, then drops the rest and
   * closes the socket. Never rejects, and a second call returns the same promise.
   */
  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  // Every step is caught on its own: close() must not reject, since `void connector.close()` would then crash the
  // host app, and a failed flush must still close the socket
  private async shutDown(): Promise<void> {
    // Up to its first await an async function runs inside its caller: this keeps handlers out of close()
    await Promise.resolve();
    const attempt = this.attempt;
    try {
      clearTimeout(this.reconnectTimer);
      attempt?.stopPinging();
      await this.flushQueued(attempt);
    } catch (error) {
      this.logInternalError(error);
    }

    try {
      this.batcher.detach();
      this.reportDropped(this.batcher.discard());
      this.attempt = undefined;
      await attempt?.stop();
    } catch (error) {
      this.logInternalError(error);
    } finally {
      this.setStatus("closed");
      this.statusHandlers.clear();
      this.messageHandlers.clear();
      this.logger.flush();
    }
  }

  // Only a session the hub has welcomed gets anything; the batcher may not be attached yet when close() came from a
  // `connected` status handler, so the attempt is passed in. The timer is ref'd: it is what keeps the process alive
  // while the messages go out, and the only thing, so nothing can hold it past `closeTimeoutMs`.
  private async flushQueued(attempt: Attempt | undefined): Promise<void> {
    if (attempt === undefined || this.status !== "connected") {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const cutOff = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.closeTimeoutMs);
      this.endFlush = resolve;
    });
    try {
      await Promise.race([this.batcher.drain(attempt, this.agreedModules), cutOff]);
    } finally {
      clearTimeout(timer);
      this.endFlush = undefined;
    }
  }

  private reportDropped(count: number): void {
    if (count === 0) {
      return;
    }

    const messages = count === 1 ? "1 queued message" : `${String(count)} queued messages`;
    this.log("warn", `close() dropped ${messages} it could not send`, "close-dropped");
  }

  // Microtask and timer callbacks are a boundary: a throw there would crash the host app
  private openSafely(): void {
    try {
      this.open();
    } catch (error) {
      this.logInternalError(error);
    }
  }

  private open(): void {
    if (this.isClosing() || this.target === undefined) {
      return;
    }

    this.setStatus("connecting");
    // A status handler may have called close()
    if (this.isClosing()) {
      return;
    }

    const { token, service, labels } = this.options;
    const hello = buildHello({ instanceId: this.instanceId, service, labels, modules: this.modules });
    this.log("debug", `connecting to the hub at ${this.target.description}`, "connecting");
    try {
      this.attempt = new Attempt({ target: this.target, token, hello }, this.attemptEvents);
    } catch (error) {
      // ws throws only for options the URL check has already ruled out, so this is a bug like any other
      const code = readErrorCode(error);
      const message = `could not open a WebSocket to the hub${code === undefined ? "" : ` (${code})`}`;
      this.onAttemptEnd({ level: "error", message, key: "hub-open-failed", isRejection: false });
    }
  }

  private onWelcome({ agreed, refused }: ModuleAgreement): void {
    if (this.isClosing()) {
      return;
    }

    this.agreedModules = agreed;
    this.backoff.reset();
    for (const module of refused) {
      this.log(
        "warn",
        `the hub did not accept the module ${module}; its messages are dropped`,
        `module-refused:${module}`,
      );
    }

    this.log("info", `connected to the hub at ${this.target?.description ?? "?"}`, "connected");
    this.setStatus("connected");
    // A status handler may have called close()
    if (!this.isClosing() && this.attempt !== undefined) {
      this.batcher.attach(this.attempt, this.agreedModules);
    }
  }

  private deliver(message: Message): void {
    if (this.isClosing()) {
      return;
    }

    // The list calls a snapshot, so a handler that unsubscribes or calls close() does not skip the others
    this.messageHandlers.call(message);
  }

  private onAttemptEnd(failure: AttemptFailure): void {
    if (this.isClosing()) {
      // Ended while close() flushes: still logged, and the flush stops, but nothing reconnects
      this.log(failure.level, failure.message, failure.key);
      this.endFlush?.();
      return;
    }

    this.attempt = undefined;
    this.agreedModules = new Set();
    this.batcher.detach();
    try {
      this.log(failure.level, failure.message, failure.key);
      if (failure.isRejection) {
        this.backoff.jumpToMax();
      }

      this.setStatus("disconnected");
    } finally {
      // Whatever failed above, the connector must not stay without an attempt; a status handler may have closed it
      if (!this.isClosing()) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.openSafely();
    }, this.backoff.nextWaitMs());
    this.reconnectTimer.unref();
  }

  // A method, not a field check: TypeScript would narrow the field and miss a close() made by a status handler
  private isClosing(): boolean {
    return this.closing !== undefined;
  }

  private setStatus(next: ConnectorStatus): void {
    if (this.status === next) {
      return;
    }

    this.status = next;
    this.statusHandlers.call(next);
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, key: string): void {
    this.logger.log(level, message, { component: COMPONENT, key });
  }

  // A bug in the connector itself: only the code is logged, since an error's message may quote a URL
  private logInternalError(error: unknown): void {
    const code = readErrorCode(error);
    const message = `the connector hit an unexpected error${code === undefined ? "" : ` (${code})`}`;
    this.log("error", message, "internal-error");
  }
}
