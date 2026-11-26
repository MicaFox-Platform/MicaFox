import type { Logger } from "pino";

import { createPostgresLocks, PGLITE_LOCKS } from "./advisory-lock.js";
import { createCoreJobs } from "./core-jobs.js";
import { scheduleFeatureJob } from "./feature-jobs.js";
import { scheduleRetention, warnUnusedRetentionDays } from "./retention.js";
import { createRunCounts } from "./run-counts.js";
import type { RunCount } from "./run-counts.js";
import { createScheduler } from "./scheduler.js";
import type { JobClock } from "./scheduler.js";
import type { KeyUses } from "../access/index.js";
import type { Database } from "../db/index.js";
import type { FeatureRegistry, Gate, SdkApi } from "../feature/index.js";
import type { Instances } from "../sdk-endpoint/index.js";

export type { RunCount, RunResult } from "./run-counts.js";
export type { JobClock } from "./scheduler.js";

/** What the jobs need from the hub. */
export interface JobsOptions {
  db: Database;
  /** The app role's URL; each run's lock takes a connection of its own to it. */
  databaseUrl: string;
  registry: FeatureRegistry;
  gate: Gate;
  /** `MICAFOX_RETENTION_<NAME>_DAYS` by policy name. */
  retentionDays: Readonly<Record<string, number>>;
  log: Logger;
  clock: JobClock;
  /** The last use of project keys the SDK endpoint notes; a core job writes it. */
  keyUses: KeyUses;
  /** The connected instances; core jobs write their last seen time and delete the stale ones. */
  instances: Instances;
  /** What a feature's jobs get to resend the state of an SDK module. */
  sdk: SdkApi;
}

/** The hub's jobs: hub-core's, the features', and a job per retention policy. */
export interface Jobs {
  /** Starts every job; the hub calls it once it is ready. */
  start: () => void;
  /** Starts no new run; the running ones go on. The hub calls it as soon as it begins to stop. */
  halt: () => void;
  /** Starts no new run and aborts the running ones; settles when they have ended. */
  stop: () => Promise<void>;
  /** The runs of each job by result since the hub started. */
  runs: () => RunCount[];
}

/** Builds the jobs of the hub: docs/architecture/hub/server.md#jobs. Nothing runs before `start`. */
export const createJobs = (options: JobsOptions): Jobs => {
  const { db, gate, log, clock, registry, retentionDays, sdk } = options;
  const locks = options.databaseUrl.startsWith("pglite:")
    ? PGLITE_LOCKS
    : createPostgresLocks(options.databaseUrl, log);
  warnUnusedRetentionDays(registry.retention, retentionDays, log);
  const parts = { db, gate, log };
  const counts = createRunCounts();
  const scheduler = createScheduler({
    jobs: [
      ...createCoreJobs({ db, now: clock.now, keyUses: options.keyUses, instances: options.instances }),
      ...registry.jobs.map((job) => scheduleFeatureJob(job, { ...parts, sdk })),
      ...registry.retention.map((policy) => scheduleRetention(policy, { ...parts, retentionDays, now: clock.now })),
    ],
    locks,
    counts,
    log,
    clock,
  });
  return { start: scheduler.start, halt: scheduler.halt, stop: scheduler.stop, runs: counts.list };
};
