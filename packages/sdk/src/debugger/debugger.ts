import type { Connector, ConnectorStatus, Message } from "@micafox/protocol";
import { Session, url as readInspectorUrl } from "node:inspector";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

import { Breakpoints } from "./breakpoints/index.js";
import { chooseConnector, type ConnectorChoice } from "./connector-choice.js";
import { ConnectorLink } from "./connector-link.js";
import { InspectorSession, type InspectorBinding } from "./inspector-session.js";
import { readConfigureOptions, resolveEnabled, type ConfiguredOptions, type DebuggerOptions } from "./options.js";
import { Pauses } from "./pauses/index.js";
import { RateLimiter } from "./rate-limiter/index.js";
import { resolveRedaction, type RedactionRules } from "./redaction/index.js";
import { HubConnector, type HubConnectorOptions, type Warn } from "../connector/index.js";
import { createLogger, type Environment, type Logger, type SdkLogger } from "../logger/index.js";

const COMPONENT = "debugger";

/** What the `Debugger` needs from outside; tests replace the process and the inspector here. */
export interface DebuggerDependencies {
  env?: Environment;
  /** Where the debugger's logger writes when the app passes no `logger`. */
  console?: Logger;
  /** The URL of an open inspector, as `inspector.url()` returns it. */
  inspectorUrl?: () => string | undefined;
  isMainThread?: boolean;
  createInspectorBinding?: () => InspectorBinding;
  /** Creates the default connector, which `run()` uses when the app sets no `connector`. */
  createHubConnector?: (options: HubConnectorOptions) => Connector;
}

/** A start step failed: the inspector session could not connect. */
class DebuggerStartError extends Error {
  override readonly name = "DebuggerStartError";
}

/** What one `run()` started, so that `stop()` undoes exactly that. */
interface Running {
  readonly connector: ConnectorChoice;
  readonly link: ConnectorLink;
  readonly session: InspectorSession;
  readonly breakpoints: Breakpoints;
  readonly pauses: Pauses;
}

type State = { kind: "notRunning" } | { kind: "running"; running: Running } | { kind: "stopping"; done: Promise<void> };

const NOT_RUNNING: State = { kind: "notRunning" };

/** The type of `micafox`: three methods, so an app can write a test double of it (docs/api/sdk/debugger.md). */
export interface Debugger {
  configure(options?: DebuggerOptions): void;
  run(): void;
  stop(): Promise<void>;
}

/**
 * The debugger: `configure()`, `run()` and `stop()` in any order, never throwing into the app. It is not running,
 * running or stopping.
 */
export class MicafoxDebugger implements Debugger {
  private readonly logger: SdkLogger;
  private readonly env: Environment;
  private readonly inspectorUrl: () => string | undefined;
  private readonly isMainThread: boolean;
  private readonly createInspectorBinding: () => InspectorBinding;
  private readonly createHubConnector: (options: HubConnectorOptions) => Connector;
  private readonly warn: Warn = (message) => {
    this.logger.log("warn", message, { component: COMPONENT });
  };
  private configured: ConfiguredOptions = {};
  private state: State = NOT_RUNNING;

  constructor(dependencies: DebuggerDependencies = {}) {
    this.env = dependencies.env ?? process.env;
    this.inspectorUrl = dependencies.inspectorUrl ?? readInspectorUrl;
    this.isMainThread = dependencies.isMainThread ?? isMainThread;
    this.createInspectorBinding = dependencies.createInspectorBinding ?? ((): InspectorBinding => new Session());
    this.createHubConnector = dependencies.createHubConnector ?? ((options): Connector => new HubConnector(options));
    // One logger for the debugger's lifetime: configure() and run() only change its target and level
    this.logger = createLogger({ component: COMPONENT, env: this.env, console: dependencies.console ?? console });
  }

  /** Merges `options` over the earlier ones for the next `run()`; while running or stopping it only warns. */
  configure(options?: DebuggerOptions): void {
    try {
      if (this.state.kind !== "notRunning") {
        this.warn(`configure() while the debugger is ${this.state.kind} changes nothing; call it before run()`);
        return;
      }

      this.merge(options);
    } catch (error) {
      this.logInternalError(error);
    }
  }

  /** Starts the debugger and returns at once; while running it does nothing, while stopping it only warns. */
  run(): void {
    try {
      switch (this.state.kind) {
        case "notRunning":
          this.start();
          return;
        case "running":
          return;
        case "stopping":
          this.warn("run() while the debugger is stopping does nothing; call it after stop() resolves");
          return;
      }
    } catch (error) {
      this.logInternalError(error);
    }
  }

  /** Stops the debugger; resolves at once when not running, and returns the same promise while stopping. */
  stop(): Promise<void> {
    try {
      switch (this.state.kind) {
        case "notRunning":
          return Promise.resolve();
        case "running":
          return this.shutDown(this.state.running);
        case "stopping":
          return this.state.done;
      }
    } catch (error) {
      this.logInternalError(error);
      return Promise.resolve();
    }
  }

  private merge(options: unknown): void {
    // Warnings wait until `logger` and `logLevel` of this call apply, so they already use them
    const early: string[] = [];
    const fields = readConfigureOptions(options, (message) => {
      early.push(message);
    });

    if (fields !== undefined) {
      this.configured = { ...this.configured, ...fields };
      if (fields.logger !== undefined || fields.logLevel !== undefined) {
        this.applyLoggerOptions();
      }
    }

    for (const message of early) {
      this.warn(message);
    }
  }

  private applyLoggerOptions(): void {
    this.logger.set({ logger: this.configured.logger, logLevel: this.configured.logLevel }, COMPONENT);
  }

  // docs/architecture/sdk/debugger.md#starting
  private start(): void {
    const options = this.configured;
    this.applyLoggerOptions();

    if (!resolveEnabled(options.enabled, this.env, this.warn)) {
      this.logger.log("info", "turned off by enabled or MICAFOX_ENABLED; not started", { component: COMPONENT });
      return;
    }

    const refusal = this.findRefusal();
    if (refusal !== undefined) {
      this.warn(refusal);
      return;
    }

    const choice = chooseConnector(options, {
      env: this.env,
      logger: this.logger,
      warn: this.warn,
      createHubConnector: this.createHubConnector,
    });
    if (choice === undefined) {
      return;
    }

    // Resolved once per run()
    const redaction = resolveRedaction(options.redact, this.env, this.warn);
    this.startWith(choice, redaction);
  }

  private findRefusal(): string | undefined {
    if (!this.isMainThread) {
      return "run() in a worker thread does nothing; MicaFox debugs the main thread only";
    }

    // Another debugger may be attached; MicaFox resumes every pause it did not cause, so it stays off
    if (this.inspectorUrl() !== undefined) {
      return "the inspector is already open (--inspect or inspector.open()); not started";
    }

    return undefined;
  }

  // The parts of one run(); `fail` stops the debugger only while this run is the current one
  private createRunning(choice: ConnectorChoice, redaction: RedactionRules, fail: (error: unknown) => void): Running {
    const link = new ConnectorLink(choice.connector, this.logger);
    const session = new InspectorSession(this.logger, this.createInspectorBinding());
    const limiter = new RateLimiter(() => performance.now());
    const send = (message: Message): void => {
      link.send(message);
    };
    const breakpoints = new Breakpoints({
      session,
      logger: this.logger,
      send,
      fail,
      onRemoved: (id) => {
        limiter.forget(id);
      },
    });
    const pauses = new Pauses({
      session,
      logger: this.logger,
      breakpoints,
      limiter,
      isSecret: (name) => redaction.isSecret(name),
      send,
      fail,
    });
    return { connector: choice, link, session, breakpoints, pauses };
  }

  private startWith(choice: ConnectorChoice, redaction: RedactionRules): void {
    const running = this.createRunning(choice, redaction, (error) => {
      this.failRunning(running, error);
    });
    this.state = { kind: "running", running };
    const isCurrent = (): boolean => this.isCurrent(running);

    try {
      running.link.start(
        {
          onStatus: (status) => {
            this.onStatus(running, status);
          },
          onMessage: (message) => {
            this.onMessage(running, message);
          },
          onConnectRejected: (error) => {
            this.failRunning(running, error);
          },
        },
        isCurrent,
      );
      // A handler may have stopped the debugger inside start(); that stop logged why
      if (!isCurrent()) {
        return;
      }

      // The Debugger domain stays off until there are breakpoints
      const connected = running.session.connect();
      if (!connected.ok) {
        throw new DebuggerStartError("the inspector session could not connect", { cause: connected.error });
      }

      running.breakpoints.start();
      running.pauses.start();
    } catch (error) {
      this.logger.log("error", "could not start; not started", { component: COMPONENT, error });
      void this.tearDown(running);
      return;
    }

    const rules = String(redaction.count);
    this.logger.log("info", `started with ${choice.description} and ${rules} redaction rules`, {
      component: COMPONENT,
    });
  }

  private onStatus(running: Running, status: ConnectorStatus): void {
    try {
      if (!this.isCurrent(running) || status !== "closed") {
        return;
      }

      // ADR 0004: only close() may end a connector, and the debugger never closes a custom one
      this.warn("the connector reported closed; stopping");
      void this.stop();
    } catch (error) {
      this.failRunning(running, error);
    }
  }

  private onMessage(running: Running, message: Message): void {
    try {
      if (!this.isCurrent(running)) {
        return;
      }

      if (message.type === "breakpoints") {
        running.breakpoints.apply(message);
        return;
      }

      this.logger.log("debug", `ignored a ${message.type} message`, { component: COMPONENT });
    } catch (error) {
      this.failRunning(running, error);
    }
  }

  // An unexpected error while running stops the debugger, as if stop() had been called
  private failRunning(running: Running, error: unknown): void {
    if (!this.isCurrent(running)) {
      return;
    }

    this.logger.log("error", "unexpected error; stopping", { component: COMPONENT, error });
    void this.stop();
  }

  // docs/architecture/sdk/debugger.md#stopping
  private shutDown(running: Running): Promise<void> {
    return this.tearDown(running, () => {
      this.logger.log("info", "stopped", { component: COMPONENT });
      this.logger.flush();
    });
  }

  // Stopping while it runs, so calls made from inside it (by a connector or a logger) see that state; whatever
  // fails, the debugger ends not running and the promise resolves, so run() works again
  private tearDown(running: Running, finish: () => void = () => undefined): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.state = { kind: "stopping", done: promise };

    try {
      running.breakpoints.stop();
      running.pauses.stop();
      running.session.disconnect();
      running.link.unsubscribe();
    } catch (error) {
      this.logInternalError(error);
    }

    const end = (): void => {
      try {
        finish();
      } catch (error) {
        this.logInternalError(error);
      } finally {
        this.state = NOT_RUNNING;
        resolve(undefined);
      }
    };

    // A custom connector stays open, so there is nothing to wait for
    if (!running.connector.isOwned) {
      end();
      return promise;
    }

    // Closing the connector this run created sends what is buffered, so the debugger stays stopping until it ends
    void this.closeConnector(running.connector.connector).then(end);
    return promise;
  }

  // Never throws or rejects
  private async closeConnector(connector: Connector): Promise<void> {
    try {
      await connector.close();
    } catch (error) {
      this.logger.log("error", "closing the connector failed", { component: COMPONENT, error });
    }
  }

  private isCurrent(running: Running): boolean {
    return this.state.kind === "running" && this.state.running === running;
  }

  private logInternalError(error: unknown): void {
    this.logger.log("error", "unexpected internal error", { component: COMPONENT, error });
  }
}
