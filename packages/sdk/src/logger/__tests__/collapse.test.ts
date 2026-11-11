import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger, type SdkLogger } from "../index.js";

type Call = [level: string, ...args: unknown[]];

const createRecorder = (): { calls: Call[]; logger: Logger } => {
  const calls: Call[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push([level, ...args]);
    };
  return {
    calls,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
  };
};

const setup = (logLevel = "warn") => {
  const app = createRecorder();
  // The fake monotonic clock plus a skew, to move the clock without running the timers
  const clock = { skewMs: 0 };
  const now = (): number => performance.now() + clock.skewMs;
  const logger = createLogger({ component: "connector", env: {}, console: createRecorder().logger, now });
  logger.set({ logger: app.logger, logLevel }, "connector");
  return { app, clock, logger };
};

const messages = (calls: Call[]): unknown[] => calls.map(([, message]) => message);

const connectionError = Object.assign(new Error("connect ECONNREFUSED"), {
  code: "ECONNREFUSED",
  stack: "Error: connect ECONNREFUSED\n    at connect (net.js:1:1)",
});
const timeoutError = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });

const createThrowingLogger = (): Logger => {
  const fail = (): never => {
    throw new Error("transport closed");
  };
  return { debug: fail, info: fail, warn: fail, error: fail };
};

const createRejectingLogger = (): Logger => {
  // Typed `unknown`, as an app logger whose return value the SDK ignores
  const reject = (): unknown => Promise.reject(new Error("transport closed"));
  return { debug: reject, info: reject, warn: reject, error: reject };
};

const openWindows = (logger: SdkLogger, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    const fields = { component: "debugger", key: "snapshot", breakpointId: `bp-${String(index)}` };
    logger.log("warn", "snapshot failed", fields);
    logger.log("warn", "snapshot failed", fields);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("first occurrence and repeats", () => {
  it("writes the first line in full and counts the repeats inside the window", () => {
    const { app, logger } = setup();

    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    expect(app.calls).toEqual([["warn", "[micafox] connector: hub unreachable", { component: "connector" }]]);
  });

  it("writes a line with a different key in full", () => {
    const { app, logger } = setup();

    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "message dropped", { component: "connector", key: "drop" });

    expect(messages(app.calls)).toEqual([
      "[micafox] connector: hub unreachable",
      "[micafox] connector: message dropped",
    ]);
  });

  it("writes a line with a different breakpointId in full", () => {
    const { app, logger } = setup();

    logger.log("warn", "snapshot failed", { component: "debugger", key: "snapshot", breakpointId: "bp-1" });
    logger.log("warn", "snapshot failed", { component: "debugger", key: "snapshot", breakpointId: "bp-2" });

    expect(app.calls).toHaveLength(2);
  });

  it("writes a line with a different error code in full", () => {
    const { app, logger } = setup();

    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect", error: connectionError });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect", error: timeoutError });

    expect(app.calls).toHaveLength(2);
  });

  it("counts a repeat with the same breakpointId and error code", () => {
    const { app, logger } = setup();
    const fields = { component: "debugger", key: "snapshot", breakpointId: "bp-1", error: connectionError };

    logger.log("warn", "snapshot failed", fields);
    logger.log("warn", "snapshot failed", {
      ...fields,
      error: Object.assign(new Error("again"), { code: "ECONNREFUSED" }),
    });

    expect(app.calls).toHaveLength(1);
  });

  it("writes a line with the same key at another level in full", () => {
    const { app, logger } = setup();

    logger.log("warn", "token refused, retrying", { component: "connector", key: "auth" });
    logger.log("error", "token refused, retrying", { component: "connector", key: "auth" });

    expect(app.calls.map(([level]) => level)).toEqual(["warn", "error"]);
  });

  it("counts a line with the same key and another message, and sums it up with the first message", () => {
    const { app, logger } = setup();
    logger.log("warn", "hub unreachable, retrying in 1 s", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable, retrying in 2 s", { component: "connector", key: "reconnect" });

    vi.advanceTimersByTime(60_000);

    expect(messages(app.calls)).toEqual([
      "[micafox] connector: hub unreachable, retrying in 1 s",
      "[micafox] connector: hub unreachable, retrying in 1 s (repeated 1 times in 60 s)",
    ]);
  });

  it("counts thrown non-errors as one problem, whatever their code property", () => {
    const { app, logger } = setup();

    logger.log("warn", "hook failed", { component: "debugger", key: "hook", error: { code: "A" } });
    logger.log("warn", "hook failed", { component: "debugger", key: "hook", error: { code: "B" } });

    expect(app.calls).toHaveLength(1);
  });

  it("never collapses a line without a key", () => {
    const { app, logger } = setup();

    logger.log("warn", "hub unreachable", { component: "connector" });
    logger.log("warn", "hub unreachable", { component: "connector" });

    expect(app.calls).toHaveLength(2);
  });
});

describe("summary", () => {
  it("writes one line with the count and the first line's context when the window ends", () => {
    const { app, logger } = setup();
    const fields = { component: "debugger", key: "snapshot", breakpointId: "bp-1", error: connectionError };
    logger.log("warn", "snapshot failed", fields);
    logger.log("warn", "snapshot failed", fields);
    logger.log("warn", "snapshot failed", fields);

    vi.advanceTimersByTime(60_000);

    expect(app.calls.slice(1)).toEqual([
      [
        "warn",
        "[micafox] debugger: snapshot failed (repeated 2 times in 60 s)",
        {
          component: "debugger",
          breakpointId: "bp-1",
          error: { name: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED", stack: connectionError.stack },
          count: 2,
        },
      ],
    ]);
  });

  it("writes the summary at the level of the first line", () => {
    const { app, logger } = setup();
    logger.log("error", "token rejected", { component: "connector", key: "auth" });
    logger.log("error", "token rejected", { component: "connector", key: "auth" });

    vi.advanceTimersByTime(60_000);

    expect(app.calls.map(([level]) => level)).toEqual(["error", "error"]);
  });

  it("passes % in the summary as is like in any other line", () => {
    const { app, logger } = setup();
    logger.log("warn", "bad path /a%s", { component: "connector", key: "path" });
    logger.log("warn", "bad path /a%s", { component: "connector", key: "path" });

    vi.advanceTimersByTime(60_000);

    expect(app.calls[1]?.[1]).toBe("[micafox] connector: bad path /a%s (repeated 1 times in 60 s)");
  });

  it("writes the summary as the message only to the default console", () => {
    const fallback = createRecorder();
    const logger = createLogger({ component: "connector", env: {}, console: fallback.logger });
    logger.log("warn", "bad path /a%s", { component: "connector", key: "path" });
    logger.log("warn", "bad path /a%s", { component: "connector", key: "path" });

    vi.advanceTimersByTime(60_000);

    expect(fallback.calls[1]).toEqual(["warn", "[micafox] connector: bad path /a%s (repeated 1 times in 60 s)"]);
  });

  it("keeps the first line's context when the caller changes its error afterwards", () => {
    const { app, logger } = setup();
    const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", stack: "Error" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect", error });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect", error });
    error.message = "changed";

    vi.advanceTimersByTime(60_000);

    expect(app.calls[1]?.[2]).toEqual({
      component: "connector",
      error: { name: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED", stack: "Error" },
      count: 1,
    });
  });

  it("ends a window without repeats silently and writes the next occurrence in full", () => {
    const { app, logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    vi.advanceTimersByTime(60_000);
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    expect(messages(app.calls)).toEqual([
      "[micafox] connector: hub unreachable",
      "[micafox] connector: hub unreachable",
    ]);
  });

  it("opens a new window after the summary", () => {
    const { app, logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    vi.advanceTimersByTime(60_000);

    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    vi.advanceTimersByTime(60_000);

    expect(messages(app.calls)).toEqual([
      "[micafox] connector: hub unreachable",
      "[micafox] connector: hub unreachable (repeated 1 times in 60 s)",
      "[micafox] connector: hub unreachable",
      "[micafox] connector: hub unreachable (repeated 1 times in 60 s)",
    ]);
  });

  it("does not count a repeat after the window when the timer is late", () => {
    const { app, clock, logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    clock.skewMs = 61_000;
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    expect(messages(app.calls)).toEqual([
      "[micafox] connector: hub unreachable",
      "[micafox] connector: hub unreachable (repeated 1 times in 61 s)",
      "[micafox] connector: hub unreachable",
    ]);
  });

  it("drops the summary when set() raised the level above the line's", () => {
    const { app, logger } = setup("info");
    logger.log("info", "started", { component: "connector", key: "start" });
    logger.log("info", "started", { component: "connector", key: "start" });
    logger.set({ logger: app.logger, logLevel: "error" }, "connector");

    vi.advanceTimersByTime(60_000);

    expect(app.calls).toHaveLength(1);
  });
});

describe("level", () => {
  it("neither counts nor opens a window for a line below the level", () => {
    const { app, logger } = setup();
    logger.log("debug", "details", { component: "connector", key: "detail" });
    logger.log("debug", "details", { component: "connector", key: "detail" });

    logger.set({ logger: app.logger, logLevel: "debug" }, "connector");
    logger.log("debug", "details", { component: "connector", key: "detail" });
    vi.advanceTimersByTime(60_000);

    expect(app.calls).toEqual([["debug", "[micafox] connector: details", { component: "connector" }]]);
  });

  it("starts no timer for a line below the level", () => {
    const { logger } = setup();

    logger.log("debug", "details", { component: "connector", key: "detail" });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("window cap", () => {
  it("ends the oldest window at once with its summary when a 101st opens", () => {
    const { app, logger } = setup();
    openWindows(logger, 100);
    const written = app.calls.length;
    vi.advanceTimersByTime(5000);

    logger.log("warn", "snapshot failed", { component: "debugger", key: "snapshot", breakpointId: "bp-100" });

    expect(app.calls.slice(written)).toEqual([
      [
        "warn",
        "[micafox] debugger: snapshot failed (repeated 1 times in 5 s)",
        { component: "debugger", breakpointId: "bp-0", count: 1 },
      ],
      ["warn", "[micafox] debugger: snapshot failed", { component: "debugger", breakpointId: "bp-100" }],
    ]);
  });

  it("keeps the other 99 windows open when it ends the oldest", () => {
    const { app, logger } = setup();
    openWindows(logger, 101);
    const written = app.calls.length;

    vi.advanceTimersByTime(60_000);

    expect(app.calls.length - written).toBe(100);
  });
});

describe("failing app logger", () => {
  it("does not throw out of the timer when the app's logger throws on a summary", () => {
    const logger = createLogger({ component: "connector", env: {}, console: createRecorder().logger });
    logger.set({ logger: createThrowingLogger() }, "connector");
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    expect(() => {
      vi.advanceTimersByTime(60_000);
    }).not.toThrow();
  });

  it("causes no unhandled rejection when the app's logger rejects on a summary", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const logger = createLogger({ component: "connector", env: {}, console: createRecorder().logger });
    logger.set({ logger: createRejectingLogger() }, "connector");
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    vi.advanceTimersByTime(60_000);
    vi.useRealTimers();
    // Unhandled rejections are reported after the microtask queue drains
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onRejection);

    expect(rejections).toEqual([]);
  });

  it("does not throw out of log() when the app's logger throws on the summary of an evicted window", () => {
    const logger = createLogger({ component: "debugger", env: {}, console: createRecorder().logger });
    logger.set({ logger: createThrowingLogger() }, "debugger");
    openWindows(logger, 100);

    expect(() => {
      logger.log("warn", "snapshot failed", { component: "debugger", key: "snapshot", breakpointId: "bp-100" });
    }).not.toThrow();
  });
});

describe("timer", () => {
  it("runs one timer for all open windows", () => {
    const { logger } = setup();

    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "message dropped", { component: "connector", key: "drop" });
    logger.log("warn", "snapshot failed", { component: "debugger", key: "snapshot", breakpointId: "bp-1" });

    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not hold the process open", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { logger } = setup();

    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it("ends each window at its own time with one timer", () => {
    const { app, logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    vi.advanceTimersByTime(10_000);
    logger.log("warn", "message dropped", { component: "connector", key: "drop" });
    logger.log("warn", "message dropped", { component: "connector", key: "drop" });

    vi.advanceTimersByTime(50_000);

    expect(messages(app.calls)).toEqual([
      "[micafox] connector: hub unreachable",
      "[micafox] connector: message dropped",
      "[micafox] connector: hub unreachable (repeated 1 times in 60 s)",
    ]);
  });

  it("keeps a window open and waits again when the timer fires early", () => {
    const { app, clock, logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    clock.skewMs = -1000;

    vi.advanceTimersByTime(60_000);
    const writtenOnTime = app.calls.length;
    vi.advanceTimersByTime(1000);

    expect([writtenOnTime, app.calls.length]).toEqual([1, 2]);
  });

  it("ends a window after 60 s when the wall clock steps back", () => {
    const logger = createLogger({ component: "connector", env: {}, console: createRecorder().logger });
    const app = createRecorder();
    logger.set({ logger: app.logger }, "connector");
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    vi.setSystemTime(Date.now() - 3_600_000);

    vi.advanceTimersByTime(60_000);

    expect(messages(app.calls).at(-1)).toBe("[micafox] connector: hub unreachable (repeated 1 times in 60 s)");
  });

  it("stops when no window is open", () => {
    const { logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    vi.advanceTimersByTime(60_000);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("flush", () => {
  it("writes the summaries of open windows and closes them", () => {
    const { app, logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "message dropped", { component: "connector", key: "drop" });
    vi.advanceTimersByTime(7000);

    logger.flush();
    vi.advanceTimersByTime(60_000);

    expect(messages(app.calls)).toEqual([
      "[micafox] connector: hub unreachable",
      "[micafox] connector: message dropped",
      "[micafox] connector: hub unreachable (repeated 2 times in 7 s)",
    ]);
  });

  it("stops the timer", () => {
    const { logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    logger.flush();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes the next occurrence in full after closing its window", () => {
    const { app, logger } = setup();
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.flush();

    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    expect(messages(app.calls).at(-1)).toBe("[micafox] connector: hub unreachable");
  });

  it("writes nothing and starts no timer when no window is open", () => {
    const { app, logger } = setup();

    logger.flush();

    expect([app.calls, vi.getTimerCount()]).toEqual([[], 0]);
  });

  it("does not throw when the app's logger throws while it writes a summary", () => {
    const failing: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn().mockImplementation(() => {
        throw new Error("transport closed");
      }),
      error: vi.fn(),
    };
    const logger = createLogger({ component: "connector", env: {}, console: createRecorder().logger });
    logger.set({ logger: failing }, "connector");
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });
    logger.log("warn", "hub unreachable", { component: "connector", key: "reconnect" });

    expect(() => {
      logger.flush();
    }).not.toThrow();
  });
});
