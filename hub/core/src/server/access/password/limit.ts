import { HttpProblem } from "../../app/index.js";

/** Runs async tasks, at most `maxRunning` at a time and `maxWaiting` queued; a task beyond that is 429. */
export interface ConcurrencyLimit {
  run: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * scrypt takes 32 MiB and a thread of the pool each, so a burst of logins must queue instead of exhausting both.
 * The queue is bounded: `shift()` on at most `maxWaiting` entries is cheap, and past it the hub says it is busy.
 */
export const createConcurrencyLimit = (maxRunning: number, maxWaiting: number): ConcurrencyLimit => {
  let running = 0;
  const waiting: Array<() => void> = [];

  // A finished task hands its slot to the next waiting one, so `running` only drops when nobody waits
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      running -= 1;
    } else {
      next();
    }
  };

  const acquire = async (): Promise<void> => {
    if (running < maxRunning) {
      running += 1;
      return;
    }
    if (waiting.length >= maxWaiting) {
      throw new HttpProblem("rate-limited", { detail: "The hub is busy checking passwords; try again shortly" }, 1);
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };

  return {
    run: async (task) => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
};
