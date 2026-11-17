import { readErrorCode, toLogContext, type LineFields, type LogContext } from "./context.js";
import type { LineLevel } from "./level.js";

const WINDOW_MS = 60_000;
const MAX_WINDOWS = 100;

/** The line that sums up the repeats of a problem, as the logger writes it after the first occurrence. */
export interface RepeatSummary {
  level: LineLevel;
  /** The message of the first occurrence. */
  message: string;
  /** The context of the first occurrence. */
  context: LogContext;
  repeats: number;
  elapsedSeconds: number;
}

interface Window {
  readonly level: LineLevel;
  readonly message: string;
  // The plain context, not the caller's fields: a thrown error would pin its whole graph in memory for 60 s
  readonly context: LogContext;
  readonly openedAt: number;
  repeats: number;
}

// A problem is its call site's key, the breakpoint and the error code (architecture: Collapsing repeats). The level
// is part of it too, so a first `error` is never hidden behind a `warn` of the same key
const identify = (level: LineLevel, key: string, fields: LineFields): string =>
  `${level}\u0000${key}\u0000${fields.breakpointId ?? ""}\u0000${readErrorCode(fields.error) ?? ""}`;

/**
 * Collapses lines that repeat within 60 s into one summary. Memory is bounded: at most 100 windows, and opening
 * another ends the oldest with its summary. One unref'd timer runs while any window is open.
 */
export class RepeatCollapser {
  // A Map iterates in insertion order and every window lasts the same time, so the first entry expires first
  private readonly windows = new Map<string, Window>();
  private timer: NodeJS.Timeout | undefined;

  /** `now` is a monotonic clock in milliseconds: the wall clock steps on NTP corrections and VM resumes. */
  constructor(
    private readonly onSummary: (summary: RepeatSummary) => void,
    private readonly now: () => number,
  ) {}

  /** Returns the context of a line to write, or `undefined` when it repeats an open problem and was counted. */
  admit(level: LineLevel, message: string, fields: LineFields): LogContext | undefined {
    if (fields.key === undefined) {
      return toLogContext(fields);
    }

    // A repeat costs one key and one lookup: its context is never built
    const id = identify(level, fields.key, fields);
    const now = this.now();
    const open = this.windows.get(id);
    if (open !== undefined && now < open.openedAt + WINDOW_MS) {
      open.repeats += 1;
      return undefined;
    }

    if (open !== undefined) {
      // The timer is late, such as when the host app blocked the event loop: this line starts a new window
      this.end(id, open, now);
    } else if (this.windows.size >= MAX_WINDOWS) {
      this.endOldest(now);
    }
    const oldestId = this.oldestId();
    const context = toLogContext(fields);
    this.windows.set(id, { level, message, context, openedAt: now, repeats: 0 });
    if (this.oldestId() !== oldestId) {
      this.arm();
    }
    return context;
  }

  /** Writes the summaries of open windows, closes them and stops the timer. */
  flush(): void {
    const now = this.now();
    for (const [id, window] of this.windows) {
      this.end(id, window, now);
    }
    this.arm();
  }

  private end(id: string, window: Window, now: number): void {
    this.windows.delete(id);
    if (window.repeats === 0) {
      return;
    }

    this.onSummary({
      level: window.level,
      message: window.message,
      context: window.context,
      repeats: window.repeats,
      elapsedSeconds: Math.round((now - window.openedAt) / 1000),
    });
  }

  private oldestId(): string | undefined {
    return this.windows.keys().next().value;
  }

  private endOldest(now: number): void {
    for (const [id, window] of this.windows) {
      this.end(id, window, now);
      return;
    }
  }

  // The timer always waits for the oldest window; call it whenever the oldest changes
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const window of this.windows.values()) {
      this.timer = setTimeout(
        () => {
          this.onTimer();
        },
        Math.max(0, window.openedAt + WINDOW_MS - this.now()),
      );
      // A pending summary must not keep the host app alive
      this.timer.unref();
      return;
    }
  }

  private onTimer(): void {
    this.timer = undefined;
    try {
      this.endExpired(this.now());
    } catch {
      // A timer callback is a boundary: nothing may reach the host app, and the open windows still need the timer
    } finally {
      this.arm();
    }
  }

  private endExpired(now: number): void {
    for (const [id, window] of this.windows) {
      // A timer can fire a little early; the window then waits for the next one
      if (window.openedAt + WINDOW_MS > now) {
        return;
      }
      this.end(id, window, now);
    }
  }
}
