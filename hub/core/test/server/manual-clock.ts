import type { Clock } from "../../src/server/lifecycle/index.js";

/** A clock that moves only when a test says, and timers that fire only then. */
export interface ManualClock {
  clock: Clock;
  /** Moves the time on by `ms`, firing every timer that falls due, in order. */
  advance: (ms: number) => void;
  /** How many timers of `delayMs` are pending. */
  pendingOf: (delayMs: number) => number;
}

interface Timer {
  callback: () => void;
  delayMs: number;
  dueAt: number;
}

export const createManualClock = (startMs = 0): ManualClock => {
  let now = startMs;
  const timers = new Map<NodeJS.Timeout, Timer>();

  const nextDue = (until: number): [NodeJS.Timeout, Timer] | undefined =>
    [...timers].filter(([, timer]) => timer.dueAt <= until).sort(([, a], [, b]) => a.dueAt - b.dueAt)[0];

  return {
    clock: {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        // A real handle that never fires, as the key a clearTimeout passes back
        const handle = setTimeout(() => undefined, 0);
        clearTimeout(handle);
        timers.set(handle, { callback, delayMs, dueAt: now + delayMs });
        return handle;
      },
      clearTimeout: (handle) => {
        timers.delete(handle);
      },
    },
    advance: (ms) => {
      const until = now + ms;
      for (let due = nextDue(until); due !== undefined; due = nextDue(until)) {
        const [handle, timer] = due;
        timers.delete(handle);
        now = timer.dueAt;
        timer.callback();
      }
      now = until;
    },
    pendingOf: (delayMs) => [...timers.values()].filter((timer) => timer.delayMs === delayMs).length,
  };
};
