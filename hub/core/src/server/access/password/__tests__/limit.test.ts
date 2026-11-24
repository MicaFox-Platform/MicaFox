import { describe, expect, it } from "vitest";

import { createConcurrencyLimit } from "../limit.js";

// A task that stays running until `finish()`, and says when it began
const controlled = (): { task: () => Promise<string>; started: () => boolean; finish: () => void } => {
  let hasStarted = false;
  let finish = (): void => undefined;
  return {
    task: async () => {
      hasStarted = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return "done";
    },
    started: () => hasStarted,
    finish: () => {
      finish();
    },
  };
};

describe("createConcurrencyLimit", () => {
  it("runs at most the given number of tasks at once and starts the next when one ends", async () => {
    const limit = createConcurrencyLimit(2, 10);
    const [first, second, third] = [controlled(), controlled(), controlled()];
    const results = [limit.run(first.task), limit.run(second.task), limit.run(third.task)];
    await Promise.resolve();
    const startedWhileFull = [first.started(), second.started(), third.started()];
    first.finish();
    await results[0];
    await Promise.resolve();

    expect([startedWhileFull, third.started()]).toEqual([[true, true, false], true]);
    second.finish();
    third.finish();
    await Promise.all(results);
  });

  it("answers 429 rate-limited with a retry after 1 s when the queue is full", async () => {
    const limit = createConcurrencyLimit(1, 1);
    const running = controlled();
    const first = limit.run(running.task);
    const queued = limit.run(async () => await Promise.resolve("queued"));

    await expect(limit.run(async () => await Promise.resolve("late"))).rejects.toMatchObject({
      problem: "rate-limited",
      retryAfterSeconds: 1,
    });

    running.finish();
    await first;
    expect(await queued).toBe("queued");
  });

  it("frees the slot when a task fails", async () => {
    const limit = createConcurrencyLimit(1, 1);

    await expect(limit.run(async () => await Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    expect(await limit.run(async () => await Promise.resolve("next"))).toBe("next");
  });
});
