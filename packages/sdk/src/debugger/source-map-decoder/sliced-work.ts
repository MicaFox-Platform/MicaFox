/**
 * Counts units of work (a character of mappings, a comparison of a sort) and says when a slice is spent. A fixed
 * count instead of a clock keeps slices equal on every machine and lets tests check them without waiting.
 */
export class WorkBudget {
  private used = 0;

  constructor(private readonly unitsPerSlice: number) {}

  /** Adds `units` and returns true when the slice is spent; the next slice then starts empty. */
  spend(units: number): boolean {
    this.used += units;
    if (this.used < this.unitsPerSlice) {
      return false;
    }

    this.used = 0;
    return true;
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Runs a job that yields after every spent slice, giving the event loop a turn between slices. */
export const runSliced = async <T>(job: Generator<void, T, void>): Promise<T> => {
  for (let step = job.next(); ; step = job.next()) {
    if (step.done === true) {
      return step.value;
    }

    await yieldToEventLoop();
  }
};
