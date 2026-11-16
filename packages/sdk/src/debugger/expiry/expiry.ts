/** What `Expiry` needs from the debugger. */
export interface ExpiryDependencies {
  /** The monotonic clock in milliseconds, such as `performance.now()`. */
  now: () => number;
  /** Called from the timer with the ids past their deadline, which `Expiry` has already forgotten. */
  onDue: (ids: string[]) => void;
  /** Reports an unexpected error from the timer: the debugger stops itself. */
  fail: (error: unknown) => void;
}

/**
 * The deadlines of the listed entries on a monotonic clock, with one unref'd timer set to the nearest, so a deadline
 * passes with no hub and never keeps the process alive (docs/architecture/sdk/debugger.md#expiring-a-breakpoint).
 * Holds at most one deadline per entry, so at most 100.
 */
export class Expiry {
  private readonly deadlines = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly dependencies: ExpiryDependencies) {}

  /** Sets the deadline of `id`; call `schedule()` once after a batch. */
  set(id: string, deadline: number): void {
    this.deadlines.set(id, deadline);
  }

  delete(id: string): void {
    this.deadlines.delete(id);
  }

  /** Sets the timer to the nearest deadline, or clears it when there is none. */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.deadlines.size === 0) {
      return;
    }

    const waitMs = Math.min(...this.deadlines.values()) - this.dependencies.now();
    // Timers wait at most 24 h here: a longer one would fire at once
    this.timer = setTimeout(
      () => {
        this.onTimer();
      },
      Math.max(1, Math.ceil(waitMs)),
    );
    this.timer.unref();
  }

  /** Forgets every deadline and clears the timer; the debugger is stopping. */
  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deadlines.clear();
  }

  // The timer may fire a little before the deadline on the monotonic clock; then nothing is due and it is set again
  private onTimer(): void {
    this.timer = undefined;
    try {
      const current = this.dependencies.now();
      const due = [...this.deadlines].flatMap(([id, deadline]) => (deadline <= current ? [id] : []));
      for (const id of due) {
        this.deadlines.delete(id);
      }

      if (due.length > 0) {
        this.dependencies.onDue(due);
      }

      this.schedule();
    } catch (error) {
      this.dependencies.fail(error);
    }
  }
}
