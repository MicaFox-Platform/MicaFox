import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLog } from "../../../../test/server/log-capture.js";
import type { HeldLock, JobLocks } from "../advisory-lock.js";
import { PGLITE_LOCKS } from "../advisory-lock.js";
import { createRunCounts } from "../run-counts.js";
import type { RunCounts } from "../run-counts.js";
import { createScheduler, JobTimeoutError } from "../scheduler.js";
import type { JobClock, ScheduledJob, Scheduler } from "../scheduler.js";

const MINUTE_MS = 60_000;

const clock: JobClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

interface Harness {
  scheduler: Scheduler;
  counts: RunCounts;
  log: ReturnType<typeof captureLog>;
}

const schedulers: Scheduler[] = [];

const schedule = (jobs: readonly ScheduledJob[], locks: JobLocks = PGLITE_LOCKS): Harness => {
  const log = captureLog();
  const counts = createRunCounts();
  const scheduler = createScheduler({ jobs, locks, counts, log: pino({ level: "debug" }, log.stream), clock });
  schedulers.push(scheduler);
  return { scheduler, counts, log };
};

// A job that records when each run starts, and takes `takesMs` to end
const recordingJob = (
  overrides: Partial<ScheduledJob> & { takesMs?: number } = {},
): ScheduledJob & {
  startedAt: number[];
} => {
  const startedAt: number[] = [];
  const { takesMs = 0, ...job } = overrides;
  return {
    name: "expire",
    everyMs: MINUTE_MS,
    run: async () => {
      startedAt.push(Date.now());
      if (takesMs > 0) {
        // Ignores its signal: a run that does not give way is what the next run must wait for
        await new Promise((resolve) => setTimeout(resolve, takesMs));
      }
    },
    startedAt,
    ...job,
  };
};

// A job whose runs end only when their signal aborts, with the reason
const abortableJob = (everyMs: number): ScheduledJob & { reasons: unknown[] } => {
  const reasons: unknown[] = [];
  return {
    name: "hang",
    everyMs,
    run: async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          reasons.push(signal.reason);
          resolve();
        });
      });
    },
    reasons,
  };
};

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(async () => {
  const stops = schedulers.splice(0).map(async (scheduler) => {
    await scheduler.stop();
  });
  // A run that ignores its signal ends with its own timer
  await vi.runAllTimersAsync();
  await Promise.all(stops);
  vi.useRealTimers();
});

describe("createScheduler", () => {
  it("runs each job when it starts and then every everyMs", async () => {
    const job = recordingJob();
    const { scheduler } = schedule([job]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    expect(job.startedAt).toEqual([0, MINUTE_MS, 2 * MINUTE_MS]);
  });

  it("starts the next run only after a run longer than the interval ends", async () => {
    const job = recordingJob({ takesMs: 90_000 });
    const { scheduler } = schedule([job]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS - 1);

    // The run ends at 90 s; the next one's timer of 0 ms fires 1 ms later, as Node's does
    expect(job.startedAt).toEqual([0, 90_001]);
  });

  it("skips and counts a run whose lock another replica holds", async () => {
    const job = recordingJob();
    const { scheduler, counts } = schedule([job], {
      tryLock: async () => {
        await Promise.resolve(undefined);
      },
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect({ runs: job.startedAt.length, counts: counts.list() }).toEqual({
      runs: 0,
      counts: [{ job: "expire", result: "skipped", count: 2 }],
    });
  });

  it("logs and counts a failed run and runs the job again on time", async () => {
    let calls = 0;
    const job: ScheduledJob = {
      name: "expire",
      everyMs: MINUTE_MS,
      run: async () => {
        calls += 1;
        await Promise.reject(new Error(`run ${String(calls)} broke`));
      },
    };
    const { scheduler, counts, log } = schedule([job]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect({
      counts: counts.list(),
      logged: log.lines().filter((line) => line.msg === "A job failed").length,
    }).toEqual({ counts: [{ job: "expire", result: "failed", count: 2 }], logged: 2 });
  });

  it("counts a run as failed and keeps running when its lock cannot be taken", async () => {
    const locks: JobLocks = { tryLock: async () => await Promise.reject(new Error("connection refused")) };
    const { scheduler, counts } = schedule([recordingJob()], locks);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(counts.list()).toEqual([{ job: "expire", result: "failed", count: 2 }]);
  });

  it("aborts a run at its interval and counts it as a timeout", async () => {
    const job = abortableJob(MINUTE_MS);
    const { scheduler, counts } = schedule([job]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect({ isTimeout: job.reasons[0] instanceof JobTimeoutError, counts: counts.list() }).toEqual({
      isTimeout: true,
      counts: [{ job: "hang", result: "timeout", count: 1 }],
    });
  });

  it("limits a run to 10 minutes however long its interval", async () => {
    const job = abortableJob(60 * MINUTE_MS);
    const { scheduler } = schedule([job]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 1);
    const beforeLimit = job.reasons.length;
    await vi.advanceTimersByTimeAsync(1);

    expect([beforeLimit, job.reasons.length]).toEqual([0, 1]);
  });

  it("releases the lock after each run", async () => {
    const released: string[] = [];
    const lock = (job: string): HeldLock => ({
      lost: new AbortController().signal,
      release: async () => {
        released.push(job);
        await Promise.resolve();
      },
    });
    const { scheduler } = schedule([recordingJob()], { tryLock: async (job) => await Promise.resolve(lock(job)) });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(released).toEqual(["expire"]);
  });

  it("aborts and counts as failed a run whose lock connection is lost", async () => {
    const lost = new AbortController();
    const job = abortableJob(MINUTE_MS);
    const locks: JobLocks = {
      tryLock: async () =>
        await Promise.resolve({
          lost: lost.signal,
          release: async () => {
            await Promise.resolve();
          },
        }),
    };
    const { scheduler, counts } = schedule([job], locks);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    lost.abort(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(0);

    expect([job.reasons, counts.list()]).toEqual([
      [new Error("connection lost")],
      [{ job: "hang", result: "failed", count: 1 }],
    ]);
  });

  it("aborts the running runs on stop and settles once they end", async () => {
    const job = abortableJob(MINUTE_MS);
    const { scheduler } = schedule([job]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    await scheduler.stop();

    expect(job.reasons).toEqual([new Error("The hub is stopping")]);
  });

  it("starts no run after halt and lets the running one go on unaborted", async () => {
    const job = abortableJob(MINUTE_MS);
    const other = recordingJob({ everyMs: 1000 });
    const { scheduler } = schedule([job, other]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    scheduler.halt();
    await vi.advanceTimersByTimeAsync(5000);

    expect([job.reasons, other.startedAt]).toEqual([[], [0]]);
  });

  it("starts no run after stop", async () => {
    const job = recordingJob();
    const { scheduler } = schedule([job]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

    expect(job.startedAt).toEqual([0]);
  });

  it("starts no run whose lock arrives after the stop began, and releases the lock", async () => {
    const job = recordingJob();
    const arrival: { give: () => void } = { give: () => undefined };
    const released: string[] = [];
    const locks: JobLocks = {
      tryLock: async () => {
        await new Promise<void>((resolve) => {
          arrival.give = resolve;
        });
        return {
          lost: new AbortController().signal,
          release: async () => {
            released.push("released");
            await Promise.resolve();
          },
        };
      },
    };
    const { scheduler } = schedule([job], locks);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopped = scheduler.stop();
    arrival.give();
    await stopped;

    expect([job.startedAt, released]).toEqual([[], ["released"]]);
  });

  it("does not log a run that ends by throwing on stop as a failure", async () => {
    const job: ScheduledJob = {
      name: "batches",
      everyMs: MINUTE_MS,
      run: async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted between batches"));
          });
        });
      },
    };
    const { scheduler, log } = schedule([job]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    await scheduler.stop();

    expect(log.lines().map((line) => line.msg)).toEqual(["A job ended early"]);
  });
});
