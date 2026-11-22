import type { Logger } from "pino";

const WINDOW_MS = 60_000;
// Keys come from remote input, such as rejected keys: past this many open keys, the rest share one window
const MAX_OPEN_KEYS = 1000;
// A symbol, so no real key can land in the window of the keys past the limit
const OVERFLOW = Symbol("overflow");
const OVERFLOW_MESSAGE = "Warnings of more keys than the hub tracks at once";

type Slot = string | typeof OVERFLOW;

/** The timer functions the hub needs, passed in so tests control time. */
export interface Timers {
  setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimeout: (handle: NodeJS.Timeout) => void;
}

interface Window {
  line: Record<string, unknown>;
  message: string;
  repeats: number;
  timer: NodeJS.Timeout;
}

/** Warnings with a key: the first is logged at once, then one line a minute with the count of its repeats. */
export interface WarnCollapser {
  warn: (key: string, fields: Record<string, unknown>, message: string) => void;
  /** Logs the pending counts now and stops the timers; for the stop sequence. */
  flush: () => void;
}

/** Creates a collapser that writes to `log`. */
export const createWarnCollapser = (log: Logger, timers: Timers): WarnCollapser => {
  const windows = new Map<Slot, Window>();

  const logCount = (window: Window): void => {
    log.warn({ ...window.line, count: window.repeats }, window.message);
  };

  const schedule = (slot: Slot): NodeJS.Timeout => {
    const timer = timers.setTimeout(() => {
      endMinute(slot);
    }, WINDOW_MS);
    // A pending minute must not keep a stopping process alive
    timer.unref();
    return timer;
  };

  // A key that keeps repeating keeps its window, one line a minute; a quiet minute closes it
  const endMinute = (slot: Slot): void => {
    const window = windows.get(slot);
    if (window === undefined) {
      return;
    }
    if (window.repeats === 0) {
      windows.delete(slot);
      return;
    }
    logCount(window);
    window.repeats = 0;
    window.timer = schedule(slot);
  };

  const warn: WarnCollapser["warn"] = (key, fields, message) => {
    const isTracked = windows.has(key) || windows.size < MAX_OPEN_KEYS;
    const slot: Slot = isTracked ? key : OVERFLOW;
    const open = windows.get(slot);
    if (open !== undefined) {
      open.repeats += 1;
      return;
    }
    // Past the limit, the fields of one key would credit it with the others' count
    const line = isTracked ? { ...fields, key } : { overflow: true };
    const lineMessage = isTracked ? message : OVERFLOW_MESSAGE;
    log.warn(line, lineMessage);
    windows.set(slot, { line, message: lineMessage, repeats: 0, timer: schedule(slot) });
  };

  const flush = (): void => {
    for (const window of windows.values()) {
      timers.clearTimeout(window.timer);
      if (window.repeats > 0) {
        logCount(window);
      }
    }
    windows.clear();
  };

  return { warn, flush };
};
