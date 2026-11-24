import type { Logger } from "pino";

import type { JobLocks } from "./advisory-lock.js";
import type { RunCounts, RunResult } from "./run-counts.js";
import type { Timers } from "../observability/index.js";

/** Work the scheduler repeats: a core job, a feature's job over its organizations, or a retention policy. */
export interface ScheduledJob {
  /** Unique; it names the lock, the log lines and the counts. */
  name: string;
  everyMs: number;
  /** `signal` aborts at the run's time limit, when its lock is lost, or when the hub stops. */
  run: (signal: AbortSignal) => Promise<void>;
}

/** The scheduler's time, passed in so tests control it. */
export interface JobClock extends Timers {
  now: () => number;
}

/** What the scheduler needs. */
export interface SchedulerOptions {
  jobs: readonly ScheduledJob[];
  locks: JobLocks;
  counts: RunCounts;
  log: Logger;
  clock: JobClock;
}

/** Runs the jobs on their intervals until `stop`. */
export interface Scheduler {
  start: () => void;
  /** Starts no new run; the running ones go on. The hub calls it as soon as it begins to stop. */
  halt: () => void;
  /** Halts, then aborts the running runs; settles when they have ended. */
  stop: () => Promise<void>;
}

// However long its interval, a run that hangs gives way within this time
const MAX_RUN_MS = 10 * 60_000;

/** A run reached its time limit. */
export class JobTimeoutError extends Error {
  constructor(job: string, limitMs: number) {
    super(`The job "${job}" ran past its limit of ${String(limitMs)} ms`);
    this.name = "JobTimeoutError";
  }
}

// A run that throws because the hub stops is not a failure of the job
const settle = async (job: ScheduledJob, signal: AbortSignal, log: Logger): Promise<RunResult> => {
  try {
    await job.run(signal);
    return "ok";
  } catch (error) {
    if (signal.aborted) {
      log.info({ job: job.name, reason: String(signal.reason) }, "A job ended early");
    } else {
      log.error({ job: job.name, err: error }, "A job failed");
    }
    return "failed";
  }
};

// Whether the scheduler may still start runs, and the signal that aborts the running ones
interface RunState {
  isHalted: () => boolean;
  stopping: AbortSignal;
}

// A run that ends by itself after its lock was lost may have overlapped another replica's: not a clean run
const resultOf = (result: RunResult, signals: { limit: AbortSignal; lost: AbortSignal }): RunResult => {
  if (signals.limit.aborted) {
    return "timeout";
  }
  return signals.lost.aborted ? "failed" : result;
};

// One run under its lock and time limit. It never throws: whatever happens is logged and counted.
const runUnderLock = async (job: ScheduledJob, options: SchedulerOptions, state: RunState): Promise<void> => {
  const { locks, counts, log, clock } = options;
  const lock = await locks.tryLock(job.name).catch((error: unknown) => {
    log.error({ job: job.name, err: error }, "A job could not take its lock");
    counts.add(job.name, "failed");
    return null;
  });
  if (lock === null) {
    return;
  }
  if (lock === undefined) {
    log.debug({ job: job.name }, "Another replica runs the job; skipped");
    counts.add(job.name, "skipped");
    return;
  }
  // The lock can arrive after the stop began: no run starts then
  if (state.isHalted()) {
    await lock.release().catch(() => undefined);
    return;
  }
  const limitMs = Math.min(job.everyMs, MAX_RUN_MS);
  const limit = new AbortController();
  const timer = clock.setTimeout(() => {
    log.warn({ job: job.name, limitMs }, "A job ran past its time limit; it is aborted");
    limit.abort(new JobTimeoutError(job.name, limitMs));
  }, limitMs);
  const result = await settle(job, AbortSignal.any([limit.signal, lock.lost, state.stopping]), log);
  clock.clearTimeout(timer);
  counts.add(job.name, resultOf(result, { limit: limit.signal, lost: lock.lost }));
  await lock.release().catch((error: unknown) => {
    log.warn({ job: job.name, err: error }, "A job's lock could not be released; its connection is closed");
  });
};

/**
 * Creates the scheduler: each job runs first when it starts, then every `everyMs` from the start of its last run, or
 * right after a run that took longer; a job never overlaps itself.
 */
export const createScheduler = (options: SchedulerOptions): Scheduler => {
  const { clock } = options;
  const stopping = new AbortController();
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<Promise<void>>();
  let isHalted = false;
  const state: RunState = { isHalted: () => isHalted, stopping: stopping.signal };

  const halt = (): void => {
    isHalted = true;
    for (const timer of timers.values()) {
      clock.clearTimeout(timer);
    }
    timers.clear();
  };

  const schedule = (job: ScheduledJob, delayMs: number): void => {
    if (isHalted) {
      return;
    }
    const timer = clock.setTimeout(() => {
      timers.delete(job.name);
      const startedAt = clock.now();
      const run = runUnderLock(job, options, state).finally(() => {
        running.delete(run);
        schedule(job, Math.max(0, startedAt + job.everyMs - clock.now()));
      });
      running.add(run);
    }, delayMs);
    timers.set(job.name, timer);
  };

  return {
    start: () => {
      for (const job of options.jobs) {
        schedule(job, 0);
      }
    },
    halt,
    stop: async () => {
      halt();
      stopping.abort(new Error("The hub is stopping"));
      await Promise.all(running);
    },
  };
};
