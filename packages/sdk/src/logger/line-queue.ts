import type { LogContext } from "./context.js";
import type { LineLevel } from "./level.js";

const MAX_HELD_LINES = 100;

/** A line that passed the level filter and collapsing, waiting for the thread to resume. */
export interface HeldLine {
  level: LineLevel;
  message: string;
  context: LogContext;
}

/** The lines that did not fit in the queue: how many, and the component of the oldest. */
export interface DroppedLines {
  count: number;
  component: string;
}

/** What `take()` hands over: the held lines, oldest first, and what was lost. */
export interface TakenLines {
  lines: HeldLine[];
  dropped?: DroppedLines;
}

/** A queue of at most 100 lines; when full, a new line replaces the oldest one, which is counted. */
export class LineQueue {
  // Filled up to the bound, then overwritten in a ring, so a push is O(1) and nothing shifts
  private readonly slots: HeldLine[] = [];
  private oldest = 0;
  private dropped: DroppedLines | undefined;

  get length(): number {
    return this.slots.length;
  }

  push(line: HeldLine): void {
    if (this.slots.length < MAX_HELD_LINES) {
      this.slots.push(line);
      return;
    }

    const replaced = this.slots[this.oldest];
    this.dropped = {
      count: (this.dropped?.count ?? 0) + 1,
      component: this.dropped?.component ?? replaced?.context.component ?? line.context.component,
    };
    this.slots[this.oldest] = line;
    this.oldest = (this.oldest + 1) % MAX_HELD_LINES;
  }

  /** Empties the queue and returns what it held. */
  take(): TakenLines {
    const lines = [...this.slots.slice(this.oldest), ...this.slots.slice(0, this.oldest)];
    const dropped = this.dropped;
    this.slots.length = 0;
    this.oldest = 0;
    this.dropped = undefined;
    return dropped === undefined ? { lines } : { lines, dropped };
  }
}
