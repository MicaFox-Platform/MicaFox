import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLog } from "../../../../test/server/log-capture.js";
import { createWarnCollapser } from "../collapse-warnings.js";

const setup = (): {
  lines: () => Array<Record<string, unknown>>;
  collapser: ReturnType<typeof createWarnCollapser>;
} => {
  const log = captureLog();
  return { lines: log.lines, collapser: createWarnCollapser(pino({}, log.stream), globalThis) };
};

describe("createWarnCollapser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs the first warning at once", () => {
    const { lines, collapser } = setup();

    collapser.warn("sdk.key-rejected", { keyPrefix: "mfx_pk_ab" }, "A project key was rejected");

    expect(lines()).toEqual([
      expect.objectContaining({ msg: "A project key was rejected", key: "sdk.key-rejected", keyPrefix: "mfx_pk_ab" }),
    ]);
  });

  it("collapses repeats within a minute into one line with a count", () => {
    const { lines, collapser } = setup();

    for (let repeat = 0; repeat < 5; repeat += 1) {
      collapser.warn("sdk.key-rejected", {}, "A project key was rejected");
    }
    vi.advanceTimersByTime(60_000);

    expect(lines()).toEqual([
      expect.not.objectContaining({ count: expect.anything() as unknown }),
      expect.objectContaining({ key: "sdk.key-rejected", count: 4, msg: "A project key was rejected" }),
    ]);
  });

  it("stays silent when nothing repeated", () => {
    const { lines, collapser } = setup();

    collapser.warn("a", {}, "once");
    vi.advanceTimersByTime(120_000);

    expect(lines()).toHaveLength(1);
  });

  it("keeps keys apart and starts a new minute after a summary", () => {
    const { lines, collapser } = setup();

    collapser.warn("a", {}, "a");
    collapser.warn("b", {}, "b");
    vi.advanceTimersByTime(60_000);
    collapser.warn("a", {}, "a");

    expect(lines().map((line) => line.key)).toEqual(["a", "b", "a"]);
  });

  it("writes one line a minute with a count while a warning keeps repeating", () => {
    const { lines, collapser } = setup();

    for (let second = 0; second < 180; second += 10) {
      collapser.warn("sdk.key-rejected", {}, "A project key was rejected");
      vi.advanceTimersByTime(10_000);
    }

    expect(lines().map((line) => line.count)).toEqual([undefined, 5, 6, 6]);
  });

  it("counts keys beyond the limit in one window without any key's fields", () => {
    const { lines, collapser } = setup();

    for (let key = 0; key < 1000; key += 1) {
      collapser.warn(`key-${String(key)}`, {}, "m");
    }
    collapser.warn("late-1", { keyPrefix: "mfx_pk_late1" }, "m");
    collapser.warn("late-2", {}, "m");
    collapser.warn("late-3", {}, "m");
    vi.advanceTimersByTime(60_000);

    expect(lines().filter((line) => line.overflow === true)).toEqual([
      expect.not.objectContaining({ count: expect.anything() as unknown, keyPrefix: expect.anything() as unknown }),
      expect.objectContaining({ count: 2 }),
    ]);
    expect(JSON.stringify(lines())).not.toContain("mfx_pk_late1");
  });

  it("never lets a real key named like the overflow share its window", () => {
    const { lines, collapser } = setup();

    collapser.warn("other", {}, "m");
    collapser.warn("overflow", {}, "m");

    expect(lines().map((line) => line.key)).toEqual(["other", "overflow"]);
  });

  it("logs pending counts on flush and stops the timers", () => {
    const { lines, collapser } = setup();
    collapser.warn("a", {}, "a");
    collapser.warn("a", {}, "a");

    collapser.flush();
    vi.advanceTimersByTime(120_000);

    expect(lines()).toEqual([expect.anything(), expect.objectContaining({ key: "a", count: 1 })]);
  });
});
