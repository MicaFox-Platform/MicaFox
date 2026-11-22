import type { Logger } from "pino";

import type { HubApp } from "../app/index.js";
import type { Timers } from "../observability/index.js";

// Kubernetes kills a pod 30 s after SIGTERM; the rest is left for the process to exit
const STOP_BUDGET_MS = 25_000;
const DRAIN_MS = 10_000;
// One hook that hangs must not take the time of the hooks after it
const HOOK_MS = 10_000;

/** Time as the stop sequence sees it, passed in so tests control it. */
export interface Clock extends Timers {
  now: () => number;
}

/** Work to do when the hub stops: before the server stops taking requests, or after it drained them. */
export interface StopHook {
  name: string;
  phase: "before-drain" | "after-drain";
  run: () => Promise<void>;
}

/** How a stop went; `clean` is false when a hook failed or ran out of time. */
export interface StopResult {
  clean: boolean;
}

interface ShutdownOptions {
  app: HubApp;
  hooks: () => readonly StopHook[];
  log: Logger;
  clock: Clock;
}

type Outcome = "done" | "timeout";

const withTimeout = async (work: Promise<void>, limitMs: number, clock: Clock): Promise<Outcome> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = clock.setTimeout(() => {
      resolve("timeout");
    }, limitMs);
  });
  try {
    return await Promise.race([work.then((): Outcome => "done"), timeout]);
  } finally {
    if (timer !== undefined) {
      clock.clearTimeout(timer);
    }
  }
};

/** Creates the stop sequence: hooks before the drain, the drain of running requests, hooks after it. */
export const createShutdown = (options: ShutdownOptions): (() => Promise<StopResult>) => {
  const { app, log, clock } = options;

  const remainingMs = (startedAt: number): number => Math.max(0, startedAt + STOP_BUDGET_MS - clock.now());

  const runHooks = async (phase: StopHook["phase"], startedAt: number): Promise<boolean> => {
    let clean = true;
    for (const hook of options.hooks().filter((candidate) => candidate.phase === phase)) {
      const limitMs = Math.min(HOOK_MS, remainingMs(startedAt));
      try {
        const outcome = await withTimeout(hook.run(), limitMs, clock);
        if (outcome === "timeout") {
          clean = false;
          log.error({ hook: hook.name }, "A stop hook ran out of time");
        }
      } catch (error) {
        clean = false;
        log.error({ hook: hook.name, err: error }, "A stop hook failed");
      }
    }
    return clean;
  };

  // Ends with false when the server could not close in time or failed to; the hooks after it run either way
  const drain = async (startedAt: number): Promise<boolean> => {
    const closing = app.close();
    // A close that is given up on may still fail later; that must not surface as an unhandled rejection
    closing.catch(() => undefined);
    try {
      if ((await withTimeout(closing, Math.min(DRAIN_MS, remainingMs(startedAt)), clock)) === "done") {
        return true;
      }
      log.warn("Requests were still running after the drain time; their connections are closed");
      app.server.closeAllConnections();
      if ((await withTimeout(closing, remainingMs(startedAt), clock)) === "done") {
        return true;
      }
      log.error("The server did not close within the stop time");
    } catch (error) {
      log.error({ err: error }, "The server failed to close");
    }
    return false;
  };

  return async () => {
    const startedAt = clock.now();
    log.info("hub.stopping");
    const beforeClean = await runHooks("before-drain", startedAt);
    const isDrained = await drain(startedAt);
    const afterClean = await runHooks("after-drain", startedAt);
    return { clean: beforeClean && isDrained && afterClean };
  };
};
