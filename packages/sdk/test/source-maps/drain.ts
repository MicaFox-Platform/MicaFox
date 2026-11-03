/** Runs a sliced job to its end without the event loop and counts how often it yielded. */
export const drain = <T>(job: Generator<void, T, void>): { value: T; yields: number } => {
  let yields = 0;
  for (let step = job.next(); ; step = job.next()) {
    if (step.done === true) {
      return { value: step.value, yields };
    }

    yields += 1;
  }
};
