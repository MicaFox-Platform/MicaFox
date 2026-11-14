// Vitest's global setup of the container tests: one stack for the whole run, removed afterwards whatever the result.

import { removeStack, startStack } from "./stack.js";

/** Removes what an interrupted run left, then builds and starts the stack. */
export const setup = (): void => {
  removeStack();
  try {
    startStack();
  } catch (error) {
    // Vitest runs no teardown after a failed setup
    removeStack();
    throw error;
  }
};

/** Runs after the last test, passed or failed. */
export const teardown = (): void => {
  removeStack();
};
