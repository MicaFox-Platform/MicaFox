import type { Logger } from "pino";

import { registerHealth } from "./health.js";
import type { Phase } from "./health.js";
import { runReadinessSteps } from "./readiness.js";
import type { ReadinessStep } from "./readiness.js";
import { createShutdown } from "./shutdown.js";
import type { Clock, StopHook, StopResult } from "./shutdown.js";
import { createApp } from "../app/index.js";
import type { AppOptions, HubApp } from "../app/index.js";
import type { Settings } from "../config/index.js";
import { loadSettings, readSecretFile, summarizeSettings } from "../config/index.js";
import { connect, createDatabase } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createLogger } from "../observability/index.js";
import type { HubLogger } from "../observability/index.js";

/** What the app that runs the hub gives it; the settings come from `env`. */
export interface HubOptions {
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  build: "hub" | "basic-hub";
  features: readonly string[];
  logStream: NodeJS.WritableStream;
  /** Reads a `*_FILE` setting's file; the default refuses a file over 64 KiB. */
  readFile?: (path: string) => string;
  clock?: Clock;
}

/** A hub that is listening; `ready` settles when its readiness steps are done. */
export interface RunningHub {
  url: string;
  ready: Promise<void>;
}

/** The hub as parts of the server use it: they add what must finish before ready and what must run on stop. */
export interface Hub {
  log: Logger;
  /** The database, through its three scopes; usable once the hub is ready. */
  db: Database;
  /** Logs a warning by key: the first at once, then one line a minute with the count of its repeats. */
  warnCollapsed: HubLogger["warnCollapsed"];
  /** Adds a step that must finish before the hub is ready; steps run in the order added, after `start()` listens. */
  addReadinessStep: (name: string, run: ReadinessStep["run"]) => void;
  /** Adds work for the stop; hooks run in the order added, after the drain unless `phase` is `before-drain`. */
  addStopHook: (name: string, run: StopHook["run"], options?: { phase?: StopHook["phase"] }) => void;
  start: () => Promise<RunningHub>;
  /** Stops the hub within 25 s; a second call returns the first one's result. */
  stop: () => Promise<StopResult>;
}

/** A step or hook was added when the hub's phase no longer allows it. */
export class HubStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubStateError";
  }
}

/** Node's own clock and timers. */
export const createSystemClock = (): Clock => ({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
});

const announceStarted = (log: Logger, options: HubOptions, settings: Settings): void => {
  log.info(
    {
      version: options.version,
      build: options.build,
      features: options.features,
      settings: summarizeSettings(settings),
    },
    "hub.started",
  );
};

// Binds the port and returns the URL users open; in test mode it is the bound port, which may be a free one
const listen = async (app: HubApp, settings: Settings): Promise<string> => {
  await app.listen({ host: settings.host, port: settings.port });
  const port = app.addresses()[0]?.port ?? settings.port;
  return settings.publicUrl ?? `http://localhost:${String(port)}`;
};

// What parts of the server register: steps before ready, and hooks for the stop
const createRegistry = (
  getPhase: () => Phase,
): Pick<Hub, "addReadinessStep" | "addStopHook"> & {
  steps: ReadinessStep[];
  /** Refuses further steps: the start has begun, and a step added now could be skipped. */
  sealSteps: () => void;
  hooks: StopHook[];
} => {
  const steps: ReadinessStep[] = [];
  const hooks: StopHook[] = [];
  let isSealed = false;
  return {
    steps,
    hooks,
    sealSteps: () => {
      isSealed = true;
    },
    addReadinessStep: (name, run) => {
      if (isSealed || getPhase() !== "starting") {
        throw new HubStateError("Readiness steps are added before the hub starts");
      }
      steps.push({ name, run });
    },
    addStopHook: (name, run, options = {}) => {
      if (getPhase() === "stopping") {
        throw new HubStateError("Stop hooks are added before the hub stops");
      }
      hooks.push({ name, run, phase: options.phase ?? "after-drain" });
    },
  };
};

// The database of the settings, and the readiness step that waits for it
const openDatabase = (
  settings: Settings,
  logger: HubLogger,
  timers: Clock,
): { db: Database; connect: ReadinessStep["run"] } => {
  const db = createDatabase({
    url: settings.databaseUrl,
    poolSize: settings.databasePoolSize,
    log: logger.log,
    warnCollapsed: logger.warnCollapsed,
  });
  return {
    db,
    connect: async (signal) => {
      await connect(db, { warnCollapsed: logger.warnCollapsed, timers }, signal);
    },
  };
};

// One stop however often it is called; a second call returns the first one's result
const createStop = (parts: {
  app: HubApp;
  hooks: () => readonly StopHook[];
  db: Database;
  logger: HubLogger;
  clock: Clock;
  beginStop: () => void;
}): Hub["stop"] => {
  const { app, hooks, db, logger, clock } = parts;
  const runShutdown = createShutdown({ app, hooks, closeDatabase: db.close, log: logger.log, clock });
  let stopping: Promise<StopResult> | undefined;
  return () => {
    stopping ??= (async () => {
      parts.beginStop();
      const result = await runShutdown();
      parts.logger.log.info({ clean: result.clean }, "hub.stopped");
      parts.logger.flush();
      return result;
    })();
    return stopping;
  };
};

const appSettingsOf = (settings: Settings): Pick<AppOptions, "trustProxy" | "publicUrl"> => ({
  trustProxy: settings.trustProxy,
  publicUrl: settings.publicUrl,
});

/** Checks every setting and builds the hub; throws a `ConfigError` with all problems when any is not valid. */
export const createHub = (options: HubOptions): Hub => {
  const settings = loadSettings({ env: options.env, readFile: options.readFile ?? readSecretFile });
  const clock = options.clock ?? createSystemClock();
  const logger = createLogger({
    level: settings.logLevel,
    format: settings.logFormat,
    stream: options.logStream,
    timers: clock,
  });
  const app = createApp({ ...appSettingsOf(settings), logger: logger.log, version: options.version });
  const { db, connect: connectDatabase } = openDatabase(settings, logger, clock);
  let phase: Phase = "starting";
  const registry = createRegistry(() => phase);
  const aborter = new AbortController();

  registerHealth(app, () => phase);
  // First, so every step a part adds later finds the database reachable and its role checked
  registry.addReadinessStep("database", connectDatabase);

  const becomeReady = async (url: string): Promise<void> => {
    await runReadinessSteps(registry.steps, aborter.signal);
    aborter.signal.throwIfAborted();
    phase = "ready";
    announceStarted(logger.log, options, { ...settings, publicUrl: url });
  };

  const start: Hub["start"] = async () => {
    registry.sealSteps();
    const url = await listen(app, settings);
    const ready = becomeReady(url);
    // A caller that never awaits `ready` must not turn a failed step into an unhandled rejection
    ready.catch(() => undefined);
    return { url, ready };
  };

  const stop = createStop({
    app,
    hooks: () => registry.hooks,
    db,
    logger,
    clock,
    beginStop: () => {
      phase = "stopping";
      aborter.abort();
    },
  });

  return {
    log: logger.log,
    db,
    warnCollapsed: logger.warnCollapsed,
    addReadinessStep: registry.addReadinessStep,
    addStopHook: registry.addStopHook,
    start,
    stop,
  };
};
