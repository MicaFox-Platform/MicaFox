import type { Logger } from "pino";

import { registerHealth } from "./health.js";
import type { Phase } from "./health.js";
import { runReadinessSteps } from "./readiness.js";
import type { ReadinessStep } from "./readiness.js";
import { createShutdown } from "./shutdown.js";
import type { Clock, StopHook, StopResult } from "./shutdown.js";
import { addAccess, ensureSetupToken } from "../access/index.js";
import type { AccessOptions, ActorResolver } from "../access/index.js";
import { createApp } from "../app/index.js";
import type { AppOptions, HubApp } from "../app/index.js";
import type { Settings } from "../config/index.js";
import { loadSettings, readSecretFile, summarizeSettings } from "../config/index.js";
import { connect, CORE_MIGRATIONS, createDatabase, migrate } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createLogger } from "../observability/index.js";
import type { HubLogger } from "../observability/index.js";

/** What the app that runs the hub gives it; the settings come from `env`. */
export interface HubOptions {
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  build: "hub" | "basic-hub";
  features: readonly string[];
  /** The migrated `.tar.gz` a `pglite:memory` or a new `pglite:<folder>` starts from. */
  pgliteSeed?: string;
  logStream: NodeJS.WritableStream;
  /** Finds who makes a request; without it the actor comes from the session cookie. Tests give their own. */
  actorResolver?: ActorResolver;
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
  firstSteps: readonly ReadinessStep[],
): Pick<Hub, "addReadinessStep" | "addStopHook"> & {
  steps: ReadinessStep[];
  /** Refuses further steps: the start has begun, and a step added now could be skipped. */
  sealSteps: () => void;
  hooks: StopHook[];
} => {
  const steps: ReadinessStep[] = [...firstSteps];
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

// The database of the settings, and the readiness steps that wait for it and for its schema: the hub adds them first,
// in that order, so every step a part adds later finds the database reachable, its role checked and its schema current;
// micafox-hub migrate runs the same steps
export const openDatabase = (
  settings: Settings,
  logger: HubLogger,
  options: { timers: Clock; pgliteSeed: string | undefined },
): { db: Database; steps: ReadinessStep[] } => {
  const { timers, pgliteSeed } = options;
  const db = createDatabase({
    url: settings.databaseUrl,
    poolSize: settings.databasePoolSize,
    log: logger.log,
    warnCollapsed: logger.warnCollapsed,
    ...(pgliteSeed === undefined ? {} : { pgliteSeed }),
  });
  const migrationUrl = settings.migrationDatabaseUrl;
  return {
    db,
    steps: [
      {
        name: "database",
        run: async (signal) => {
          await connect(db, { warnCollapsed: logger.warnCollapsed, timers }, signal);
        },
      },
      {
        name: "migrations",
        run: async (signal) => {
          await migrate(db, { url: migrationUrl, packages: [CORE_MIGRATIONS], log: logger.log }, signal);
        },
      },
    ],
  };
};

// The URL users open: given by the settings, or in test mode known once the port is bound. The origin check and the
// cookie ask for it at each request, so a request that comes before it is known is a bug.
const createPublicUrl = (initial: string | undefined): { get: () => string; set: (url: string) => void } => {
  let url = initial;
  return {
    get: () => {
      if (url === undefined) {
        throw new HubStateError("The public URL is known once the hub listens");
      }
      return url;
    },
    set: (value) => {
      url = value;
    },
  };
};

// The readiness step that makes the setup token; test mode seeds its owner instead, so no token exists there
const setupTokenSteps = (parts: {
  settings: Settings;
  db: Database;
  log: Logger;
  publicUrl: () => string;
}): ReadinessStep[] =>
  parts.settings.testMode
    ? []
    : [
        {
          name: "setup-token",
          run: async () => {
            await ensureSetupToken({
              db: parts.db,
              log: parts.log,
              publicUrl: parts.publicUrl,
              configuredToken: parts.settings.setupToken,
            });
          },
        },
      ];

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

const loggerOf = (settings: Settings, options: HubOptions, clock: Clock): HubLogger =>
  createLogger({ level: settings.logLevel, format: settings.logFormat, stream: options.logStream, timers: clock });

// A resolver the app gives replaces the session cookie's
const accessOptionsOf = (parts: {
  db: Database;
  options: HubOptions;
  clock: Clock;
  publicUrl: () => string;
}): AccessOptions => ({
  db: parts.db,
  features: parts.options.features,
  publicUrl: parts.publicUrl,
  now: parts.clock.now,
  ...(parts.options.actorResolver === undefined ? {} : { resolveActor: parts.options.actorResolver }),
});

/** Checks every setting and builds the hub; throws a `ConfigError` with all problems when any is not valid. */
export const createHub = (options: HubOptions): Hub => {
  const settings = loadSettings({ env: options.env, readFile: options.readFile ?? readSecretFile });
  const clock = options.clock ?? createSystemClock();
  const logger = loggerOf(settings, options, clock);
  const app = createApp({ ...appSettingsOf(settings), logger: logger.log, version: options.version });
  const { db, steps } = openDatabase(settings, logger, { pgliteSeed: options.pgliteSeed, timers: clock });
  const publicUrl = createPublicUrl(settings.publicUrl);
  steps.push(...setupTokenSteps({ settings, db, log: logger.log, publicUrl: publicUrl.get }));
  let phase: Phase = "starting";
  const registry = createRegistry(() => phase, steps);
  const aborter = new AbortController();
  registerHealth(app, () => phase);
  addAccess(app, accessOptionsOf({ db, options, clock, publicUrl: publicUrl.get }));

  const becomeReady = async (url: string): Promise<void> => {
    await runReadinessSteps(registry.steps, aborter.signal);
    aborter.signal.throwIfAborted();
    phase = "ready";
    announceStarted(logger.log, options, { ...settings, publicUrl: url });
  };

  const start: Hub["start"] = async () => {
    registry.sealSteps();
    const url = await listen(app, settings);
    publicUrl.set(url);
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
