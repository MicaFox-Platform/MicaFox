/** One thing that must finish before the hub is ready, such as connecting to the database; it ends or throws. */
export interface ReadinessStep {
  name: string;
  run: (signal: AbortSignal) => Promise<void>;
}

/** A readiness step threw; the step's name says which, and `cause` holds why. */
export class ReadinessError extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(`The readiness step ${step} failed`, { cause });
    this.name = "ReadinessError";
  }
}

/** Runs the steps in order; a stop aborts `signal`, which ends the wait of the step that runs. */
export const runReadinessSteps = async (steps: readonly ReadinessStep[], signal: AbortSignal): Promise<void> => {
  for (const step of steps) {
    signal.throwIfAborted();
    try {
      await step.run(signal);
    } catch (error) {
      throw signal.aborted ? error : new ReadinessError(step.name, error);
    }
  }
};
