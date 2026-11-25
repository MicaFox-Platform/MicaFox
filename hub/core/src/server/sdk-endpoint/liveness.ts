import type { SdkSessions } from "./sessions.js";
import type { Timers } from "../observability/index.js";

/** A connection that receives nothing, not even a ping, for this long is cut off; the SDK pings every 15 s. */
const IDLE_MS = 45_000;
// One sweep over the connections instead of a timer per connection reset on every frame; the cut comes within
// IDLE_MS + SWEEP_MS
const SWEEP_MS = 5000;

/** What the idle check needs. */
export interface LivenessOptions {
  sessions: SdkSessions;
  timers: Timers;
  now: () => number;
}

/** The idle check: it runs while there are connections, and cuts off the silent ones. */
export interface Liveness {
  /** Starts the sweep if it is not running; the endpoint calls it for each new connection. */
  watch: () => void;
  /** Stops the sweep; for the stop. */
  stop: () => void;
}

export const createLiveness = (options: LivenessOptions): Liveness => {
  const { sessions, timers, now } = options;
  let timer: NodeJS.Timeout | undefined;

  const sweep = (): void => {
    timer = undefined;
    const time = now();
    for (const connection of sessions.list()) {
      if (time - connection.lastActivityMs >= IDLE_MS) {
        connection.log.info({ idleMs: time - connection.lastActivityMs }, "sdk.idle");
        sessions.terminate(connection);
      }
    }
    if (sessions.size > 0) {
      timer = timers.setTimeout(sweep, SWEEP_MS);
    }
  };

  return {
    watch: () => {
      timer ??= timers.setTimeout(sweep, SWEEP_MS);
    },
    stop: () => {
      if (timer !== undefined) {
        timers.clearTimeout(timer);
        timer = undefined;
      }
    },
  };
};
