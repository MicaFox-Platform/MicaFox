import type { Logger } from "pino";

import { registerHealth } from "./health.js";
import type { Phase } from "./health.js";
import { runReadinessSteps } from "./readiness.js";
import type { ReadinessStep } from "./readiness.js";
import { createShutdown } from "./shutdown.js";
import type { Clock, StopHook, StopResult } from "./shutdown.js";
import type { FeatureParts } from "./startup.js";
import {
  addEvents,
  addJobs,
  addSdk,
  createFeatureParts,
  createPublicUrl,
  createStart,
  HubStateError,
  openDatabase,
  setupTokenSteps,
} from "./startup.js";
import { addAccess, createKeyUses } from "../access/index.js";
import type { AccessOptions, ActorResolver } from "../access/index.js";
import { createApp } from "../app/index.js";
import type { AppOptions, HubApp } from "../app/index.js";
import type { Settings } from "../config/index.js";
import { loadSettings, readSecretFile, summarizeSettings } from "../config/index.js";
import type { Database } from "../db/index.js";
import type { Events } from "../events/index.js";
import { addFeatureRoutes } from "../feature/index.js";
import type { Extension, Feature, FeatureRegistry, Gate, SdkApi } from "../feature/index.js";
import { createLogger } from "../observability/index.js";
import type { HubLogger } from "../observability/index.js";
import { createInstances, createSdkResend } from "../sdk-endpoint/index.js";
import type { Instances } from "../sdk-endpoint/index.js";

/** What the app that runs the hub gives it; the settings come from `env`. */
export interface HubOptions {
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  build: "hub" | "basic-hub";
  /** The core features in the order of their migrations; the extension's come after them. */
  features: readonly Feature[];
  /** The paid features of `ee/`, gated by entitlements; none in the basic hub. */
  extension?: Extension;
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
  /** The checked features with their jobs, retention policies and SDK modules, for the parts that run them. */
  registry: FeatureRegistry;
  /** Whether an organization may use a feature or an SDK module. */
  gate: Gate;
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
      features: options.features.map((feature) => feature.name),
      extension: options.extension?.features.map((feature) => feature.name) ?? [],
      settings: summarizeSettings(settings),
    },
    "hub.started",
  );
};

// What parts of the server register: steps before ready, and hooks for the stop
const createRegistry = (
  firstSteps: readonly ReadinessStep[],
): Pick<Hub, "addReadinessStep" | "addStopHook"> & {
  steps: ReadinessStep[];
  getPhase: () => Phase;
  /** Aborts when the stop begins, which ends the readiness steps that wait. */
  signal: AbortSignal;
  turnReady: () => void;
  beginStop: () => void;
  /** Refuses further steps: the start has begun, and a step added now could be skipped. */
  sealSteps: () => void;
  hooks: StopHook[];
} => {
  const steps: ReadinessStep[] = [...firstSteps];
  const hooks: StopHook[] = [];
  const aborter = new AbortController();
  let phase: Phase = "starting";
  let isSealed = false;
  const getPhase = (): Phase => phase;
  return {
    steps,
    hooks,
    getPhase,
    signal: aborter.signal,
    turnReady: () => {
      phase = "ready";
    },
    beginStop: () => {
      phase = "stopping";
      aborter.abort();
    },
    sealSteps: () => {
      isSealed = true;
    },
    addReadinessStep: (name, run) => {
      if (isSealed || phase !== "starting") {
        throw new HubStateError("Readiness steps are added before the hub starts");
      }
      steps.push({ name, run });
    },
    addStopHook: (name, run, options = {}) => {
      if (phase === "stopping") {
        throw new HubStateError("Stop hooks are added before the hub stops");
      }
      hooks.push({ name, run, phase: options.phase ?? "after-drain" });
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

const loggerOf = (settings: Settings, options: HubOptions, clock: Clock): HubLogger =>
  createLogger({ level: settings.logLevel, format: settings.logFormat, stream: options.logStream, timers: clock });

// A resolver the app gives replaces the session cookie's
const accessOptionsOf = (parts: {
  db: Database;
  options: HubOptions;
  clock: Clock;
  publicUrl: () => string;
  featureParts: FeatureParts;
  events: Events;
  sdk: SdkApi;
  instances: Instances;
}): AccessOptions => ({
  db: parts.db,
  events: parts.events,
  features: parts.featureParts.registry.features.map(({ feature }) => feature.name),
  entitlements: parts.featureParts.entitlements,
  addFeatureRoutes: (scope, authorization) => {
    const { registry, gate } = parts.featureParts;
    parts.instances.addRoutes(scope, authorization);
    addFeatureRoutes(scope, { registry, authorization, gate, sdk: parts.sdk });
  },
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
  const featureParts = createFeatureParts(options, clock);
  const { db, steps } = openDatabase(settings, logger, {
    pgliteSeed: options.pgliteSeed,
    timers: clock,
    registry: featureParts.registry,
  });
  const publicUrl = createPublicUrl(settings.publicUrl);
  steps.push(...setupTokenSteps({ settings, db, log: logger.log, publicUrl: publicUrl.get }));
  const lifecycle = createRegistry(steps);
  const events = addEvents({ log: logger.log, clock }, lifecycle.addStopHook);
  const keyUses = createKeyUses({ db, now: clock.now });
  const sdk = createSdkResend({ db, bus: events.bus, log: logger.log });
  const instances = createInstances({ db, bus: events.bus, now: clock.now, warnCollapsed: logger.warnCollapsed });
  const jobs = addJobs(
    { settings, db, featureParts, keyUses, instances, sdk, log: logger.log, clock },
    lifecycle.addStopHook,
  );
  registerHealth(app, lifecycle.getPhase);
  const access = addAccess(
    app,
    accessOptionsOf({ db, options, clock, publicUrl: publicUrl.get, featureParts, events, sdk, instances }),
  );
  addSdk({ app, settings, access, keyUses, instances, featureParts, events, logger, clock }, lifecycle.addStopHook);

  const becomeReady = async (url: string): Promise<void> => {
    await runReadinessSteps(lifecycle.steps, lifecycle.signal);
    lifecycle.signal.throwIfAborted();
    lifecycle.turnReady();
    jobs.start();
    announceStarted(logger.log, options, { ...settings, publicUrl: url });
  };

  const start = createStart({ app, settings, publicUrl, sealSteps: lifecycle.sealSteps, becomeReady });

  const stop = createStop({ app, hooks: () => lifecycle.hooks, db, logger, clock, beginStop: lifecycle.beginStop });

  return {
    log: logger.log,
    db,
    registry: featureParts.registry,
    gate: featureParts.gate,
    warnCollapsed: logger.warnCollapsed,
    addReadinessStep: lifecycle.addReadinessStep,
    addStopHook: lifecycle.addStopHook,
    start,
    stop,
  };
};
