import type { Logger } from "pino";

import type { ReadinessStep } from "./readiness.js";
import type { Clock, StopHook } from "./shutdown.js";
import { createEntitlements, ensureSetupToken } from "../access/index.js";
import type { Access, Entitlements, KeyUses } from "../access/index.js";
import type { HubApp } from "../app/index.js";
import type { Settings } from "../config/index.js";
import { connect, CORE_MIGRATIONS, createDatabase, migrate } from "../db/index.js";
import type { Database, MigrationPackage } from "../db/index.js";
import { createEvents } from "../events/index.js";
import type { Events } from "../events/index.js";
import { createFeatureRegistry, createGate } from "../feature/index.js";
import type { Extension, Feature, FeatureRegistry, Gate } from "../feature/index.js";
import { createJobs } from "../jobs/index.js";
import type { Jobs } from "../jobs/index.js";
import type { HubLogger } from "../observability/index.js";
import { addSdkEndpoint } from "../sdk-endpoint/index.js";

/** A step or hook was added when the hub's phase no longer allows it. */
export class HubStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubStateError";
  }
}

// The database of the settings, and the readiness steps that wait for it and for its schema: the hub adds them first,
// in that order, so every step a part adds later finds the database reachable, its role checked and its schema current;
// micafox-hub migrate runs the same steps
export const openDatabase = (
  settings: Settings,
  logger: HubLogger,
  options: { timers: Clock; pgliteSeed: string | undefined; registry: FeatureRegistry },
): { db: Database; steps: ReadinessStep[] } => {
  const { timers, pgliteSeed } = options;
  const packages: readonly MigrationPackage[] = [CORE_MIGRATIONS, ...options.registry.migrations];
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
          await migrate(db, { url: migrationUrl, packages, log: logger.log }, signal);
        },
      },
    ],
  };
};

// The URL users open: given by the settings, or in test mode known once the port is bound. The origin check and the
// cookie ask for it at each request, so a request that comes before it is known is a bug.
export const createPublicUrl = (initial: string | undefined): { get: () => string; set: (url: string) => void } => {
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
export const setupTokenSteps = (parts: {
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

/** The checked features, their entitlements and the gate over both. */
export interface FeatureParts {
  registry: FeatureRegistry;
  entitlements: Entitlements;
  gate: Gate;
}

/** Checks the features and builds their entitlements and gate; throws a `FeatureRegistryError` on a conflict. */
export const createFeatureParts = (
  options: { features: readonly Feature[]; extension?: Extension },
  clock: Clock,
): FeatureParts => {
  const registry = createFeatureRegistry(options.features, options.extension);
  const entitlements = createEntitlements({ sources: options.extension?.sources ?? [], now: clock.now });
  return { registry, entitlements, gate: createGate(registry, entitlements) };
};

/**
 * Builds the event bus and its streams, and adds the stop hook that ends the streams. A stream never ends by itself,
 * so the drain of the running requests would wait for it: it ends first.
 */
export const addEvents = (
  parts: { log: Logger; clock: Clock },
  addStopHook: (name: string, run: () => Promise<void>, options?: { phase?: StopHook["phase"] }) => void,
): Events => {
  const events = createEvents({ log: parts.log, timers: parts.clock });
  addStopHook(
    "events",
    async () => {
      events.streams.endAll();
      await Promise.resolve();
    },
    { phase: "before-drain" },
  );
  return events;
};

/**
 * Builds the hub's jobs and adds their stop hooks, which the hub adds first: before the drain no new run starts, and
 * after it the running ones are aborted and end before anything they write to closes. The hub starts them once it is
 * ready.
 */
export const addJobs = (
  parts: { settings: Settings; db: Database; featureParts: FeatureParts; keyUses: KeyUses; log: Logger; clock: Clock },
  addStopHook: (name: string, run: () => Promise<void>, options?: { phase?: StopHook["phase"] }) => void,
): Jobs => {
  const jobs = createJobs({
    db: parts.db,
    databaseUrl: parts.settings.databaseUrl,
    registry: parts.featureParts.registry,
    gate: parts.featureParts.gate,
    retentionDays: parts.settings.retentionDays,
    log: parts.log,
    clock: parts.clock,
    keyUses: parts.keyUses,
  });
  addStopHook(
    "jobs-halt",
    async () => {
      jobs.halt();
      await Promise.resolve();
    },
    { phase: "before-drain" },
  );
  addStopHook("jobs", jobs.stop);
  return jobs;
};

/**
 * Adds the SDK endpoint and the stop hook that closes its sessions with 1001 before the drain: an open WebSocket
 * would hold the drain until its peer closes.
 */
export const addSdk = (
  parts: {
    app: HubApp;
    settings: Settings;
    access: Access;
    keyUses: KeyUses;
    featureParts: FeatureParts;
    events: Events;
    logger: HubLogger;
    clock: Clock;
  },
  addStopHook: (name: string, run: () => Promise<void>, options?: { phase?: StopHook["phase"] }) => void,
): void => {
  const endpoint = addSdkEndpoint(parts.app, {
    settings: parts.settings,
    access: parts.access,
    keyUses: parts.keyUses,
    gate: parts.featureParts.gate,
    bus: parts.events.bus,
    log: parts.logger.log,
    warnCollapsed: parts.logger.warnCollapsed,
    clock: parts.clock,
  });
  addStopHook("sdk-endpoint", endpoint.closeAll, { phase: "before-drain" });
};

// Binds the port and returns the URL users open; in test mode it is the bound port, which may be a free one
const listen = async (app: HubApp, settings: Settings): Promise<string> => {
  await app.listen({ host: settings.host, port: settings.port });
  const port = app.addresses()[0]?.port ?? settings.port;
  return settings.publicUrl ?? `http://localhost:${String(port)}`;
};

/** `start()` of the hub: seals the steps, binds the port, and runs the steps in the background. */
export const createStart = (parts: {
  app: HubApp;
  settings: Settings;
  publicUrl: { set: (url: string) => void };
  sealSteps: () => void;
  becomeReady: (url: string) => Promise<void>;
}): (() => Promise<{ url: string; ready: Promise<void> }>) => {
  return async () => {
    parts.sealSteps();
    const url = await listen(parts.app, parts.settings);
    parts.publicUrl.set(url);
    const ready = parts.becomeReady(url);
    // A caller that never awaits `ready` must not turn a failed step into an unhandled rejection
    ready.catch(() => undefined);
    return { url, ready };
  };
};
