import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger, type SdkLogger } from "../index.js";

const HOLD_KEY = Symbol.for("probex.logger.hold");

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

const setup = (logLevel = "warn", component = "debugger") => {
  const app = createRecorder();
  const logger = createLogger({ component, env: {}, console: createRecorder().logger });
  logger.set({ logger: app.logger, logLevel }, component);
  return { app, logger };
};

const messages = (calls: Call[]): unknown[] => calls.map(([, message]) => message);

const lineMessage = (index: number): string => `[probex] debugger: line ${String(index)}`;

const writeLines = (logger: SdkLogger, from: number, to: number): void => {
  for (let index = from; index <= to; index += 1) {
    logger.log("warn", `line ${String(index)}`, { component: "debugger" });
  }
};

const writeErrorLines = (logger: SdkLogger, count: number): void => {
  for (let index = 1; index <= count; index += 1) {
    logger.log("error", `line ${String(index)}`, { component: "debugger" });
  }
};

const runImmediates = (): void => {
  vi.advanceTimersByTime(0);
};

const createThrowingLogger = (): Logger => {
  const fail = (): never => {
    throw new Error("transport closed");
  };
  return { debug: fail, info: fail, warn: fail, error: fail };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  Reflect.deleteProperty(globalThis, HOLD_KEY);
});

describe("hold", () => {
  it("keeps the app's logger from being called until release", () => {
    const { app, logger } = setup();

    logger.hold();
    writeLines(logger, 1, 2);
    runImmediates();

    expect(app.calls).toEqual([]);
  });

  it("makes another logger in the process queue its lines", () => {
    const first = setup();
    const second = setup("warn", "connector");

    first.logger.hold();
    second.logger.log("warn", "hub unreachable", { component: "connector" });

    expect(second.app.calls).toEqual([]);
  });

  it("makes a logger from a second module instance queue its lines", async () => {
    const first = setup();
    vi.resetModules();
    const other = await import("../index.js");
    const app = createRecorder();
    const second = other.createLogger({ component: "connector", env: {}, console: createRecorder().logger });
    second.set({ logger: app.logger, logLevel: "warn" }, "connector");

    first.logger.hold();
    second.log("warn", "hub unreachable", { component: "connector" });
    first.logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual(["[probex] connector: hub unreachable"]);
  });

  it("ends the hold of a second module instance", async () => {
    const first = setup();
    vi.resetModules();
    const other = await import("../index.js");
    const second = other.createLogger({ component: "connector", env: {}, console: createRecorder().logger });

    second.hold();
    first.logger.log("warn", "snapshot failed", { component: "debugger" });
    second.release();
    runImmediates();

    expect(messages(first.app.calls)).toEqual(["[probex] debugger: snapshot failed"]);
  });

  it("does nothing on a second hold", () => {
    const { app, logger } = setup();

    logger.hold();
    logger.hold();
    logger.log("warn", "snapshot failed", { component: "debugger" });
    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual(["[probex] debugger: snapshot failed"]);
  });

  it("writes directly again after one release that follows two holds", () => {
    const { app, logger } = setup();
    logger.hold();
    logger.hold();
    logger.release();
    runImmediates();

    logger.log("warn", "snapshot failed", { component: "debugger" });

    expect(messages(app.calls)).toEqual(["[probex] debugger: snapshot failed"]);
  });

  it("does nothing on release without hold", () => {
    const { logger } = setup();

    logger.release();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes straight through when nothing is held", () => {
    const { app, logger } = setup();

    logger.log("warn", "snapshot failed", { component: "debugger" });

    expect(messages(app.calls)).toEqual(["[probex] debugger: snapshot failed"]);
  });

  it("does not throw when the global record cannot be written", () => {
    const { logger } = setup();
    Reflect.set(globalThis, HOLD_KEY, Object.freeze({ held: false, drains: new Set() }));

    expect(() => {
      logger.hold();
      logger.release();
    }).not.toThrow();
  });

  it("does not throw when reading the global record throws", () => {
    const { app, logger } = setup();
    Object.defineProperty(globalThis, HOLD_KEY, {
      configurable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });

    logger.hold();
    logger.log("warn", "snapshot failed", { component: "debugger" });
    logger.release();

    expect(messages(app.calls)).toEqual(["[probex] debugger: snapshot failed"]);
  });

  it("honors the flag of a record from another copy that has no drains", () => {
    const { app, logger } = setup();
    Reflect.set(globalThis, HOLD_KEY, { held: true });

    logger.log("warn", "snapshot failed", { component: "debugger" });

    expect(app.calls).toEqual([]);
  });

  it("writes the queue on release under a record from another copy that has no drains", () => {
    const { app, logger } = setup();
    Reflect.set(globalThis, HOLD_KEY, { held: true });
    logger.log("warn", "snapshot failed", { component: "debugger" });

    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual(["[probex] debugger: snapshot failed"]);
  });

  it("ignores a record that is not an object", () => {
    const { app, logger } = setup();
    Reflect.set(globalThis, HOLD_KEY, "held");

    logger.hold();
    logger.log("warn", "snapshot failed", { component: "debugger" });

    expect(app.calls).toEqual([]);
  });
});

describe("queued lines", () => {
  it("does not queue a line below the level", () => {
    const { app, logger } = setup("warn");
    logger.hold();

    logger.log("debug", "resolved breakpoint", { component: "debugger" });
    logger.release();
    runImmediates();

    expect(app.calls).toEqual([]);
  });

  it("queues a repeat as a count and not as a line", () => {
    const { app, logger } = setup();
    const fields = { component: "connector", key: "reconnect" };
    logger.hold();

    logger.log("warn", "hub unreachable", fields);
    logger.log("warn", "hub unreachable", fields);
    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual(["[probex] connector: hub unreachable"]);
  });

  it("queues the summary of a window that ends during the pause", () => {
    const { app, logger } = setup();
    const fields = { component: "connector", key: "reconnect" };
    logger.log("warn", "hub unreachable", fields);
    logger.log("warn", "hub unreachable", fields);
    logger.hold();

    vi.advanceTimersByTime(60_000);

    expect(app.calls).toHaveLength(1);
  });

  it("writes a summary queued during the pause after release", () => {
    const { app, logger } = setup();
    const fields = { component: "connector", key: "reconnect" };
    logger.log("warn", "hub unreachable", fields);
    logger.log("warn", "hub unreachable", fields);
    logger.hold();
    vi.advanceTimersByTime(60_000);

    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual([
      "[probex] connector: hub unreachable",
      "[probex] connector: hub unreachable (repeated 1 times in 60 s)",
    ]);
  });

  it("drops the oldest line at 100 and writes the rest in order", () => {
    const { app, logger } = setup();
    logger.hold();

    writeLines(logger, 1, 105);
    logger.release();
    runImmediates();

    expect(messages(app.calls).slice(0, 100)).toEqual(
      Array.from({ length: 100 }, (_, index) => lineMessage(index + 6)),
    );
  });

  it("writes one warning with the number of dropped lines after the queue", () => {
    const { app, logger } = setup();
    logger.hold();

    writeLines(logger, 1, 105);
    logger.release();
    runImmediates();

    expect(app.calls.slice(100)).toEqual([
      ["warn", "[probex] debugger: log lines dropped while the thread was paused: 5", { component: "debugger" }],
    ]);
  });

  it("signs the dropped-lines warning with the component of the oldest dropped line", () => {
    const { app, logger } = setup();
    logger.hold();
    logger.log("warn", "hub unreachable", { component: "connector" });

    writeLines(logger, 1, 100);
    logger.release();
    runImmediates();

    expect(app.calls.at(-1)).toEqual([
      "warn",
      "[probex] connector: log lines dropped while the thread was paused: 1",
      { component: "connector" },
    ]);
  });

  it("writes the warning once when the queue overflows twice over", () => {
    const { app, logger } = setup();
    logger.hold();

    writeLines(logger, 1, 250);
    logger.release();
    runImmediates();

    expect(messages(app.calls).filter((message) => String(message).includes("dropped"))).toEqual([
      "[probex] debugger: log lines dropped while the thread was paused: 150",
    ]);
  });

  it("leaves out the warning when nothing was dropped", () => {
    const { app, logger } = setup();
    logger.hold();

    writeLines(logger, 1, 100);
    logger.release();
    runImmediates();

    expect(app.calls).toHaveLength(100);
  });

  it("leaves out the warning when the level lets no warning through", () => {
    const { app, logger } = setup("error");
    logger.hold();

    writeErrorLines(logger, 101);
    logger.release();
    runImmediates();

    expect(app.calls).toHaveLength(100);
  });

  it("does not call a failing app logger into the host", () => {
    const logger = createLogger({ component: "debugger", env: {}, console: createRecorder().logger });
    logger.set({ logger: createThrowingLogger(), logLevel: "warn" }, "debugger");
    logger.hold();
    writeLines(logger, 1, 105);

    logger.release();

    expect(() => {
      runImmediates();
    }).not.toThrow();
  });
});

describe("release", () => {
  it("writes nothing synchronously", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 2);

    logger.release();

    expect(app.calls).toEqual([]);
  });

  it("writes the queue in order in a setImmediate", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 3);
    logger.release();

    runImmediates();

    expect(messages(app.calls)).toEqual([lineMessage(1), lineMessage(2), lineMessage(3)]);
  });

  it("queues a line written before the immediate runs behind the held ones", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 2);
    logger.release();

    writeLines(logger, 3, 3);
    runImmediates();

    expect(messages(app.calls)).toEqual([lineMessage(1), lineMessage(2), lineMessage(3)]);
  });

  it("writes straight through once the immediate has run", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 1);
    logger.release();
    runImmediates();

    writeLines(logger, 2, 2);

    expect(messages(app.calls)).toEqual([lineMessage(1), lineMessage(2)]);
  });

  it("writes nothing when the thread is held again before the immediate runs", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 2);
    logger.release();

    logger.hold();
    runImmediates();

    expect(app.calls).toEqual([]);
  });

  it("writes the queue after the second release when it was held again", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 2);
    logger.release();
    logger.hold();
    runImmediates();

    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual([lineMessage(1), lineMessage(2)]);
  });

  it("writes the queues of every logger in the process", () => {
    const first = setup();
    const second = setup("warn", "connector");
    first.logger.hold();
    first.logger.log("warn", "snapshot failed", { component: "debugger" });
    second.logger.log("warn", "hub unreachable", { component: "connector" });

    second.logger.release();
    runImmediates();

    expect([messages(first.app.calls), messages(second.app.calls)]).toEqual([
      ["[probex] debugger: snapshot failed"],
      ["[probex] connector: hub unreachable"],
    ]);
  });
});

describe("flush", () => {
  it("writes the queue and the dropped-lines warning synchronously when not held", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 101);
    logger.release();

    logger.flush();

    expect(app.calls).toHaveLength(101);
  });

  it("cancels the pending immediate", () => {
    const { logger } = setup();
    logger.hold();
    writeLines(logger, 1, 2);
    logger.release();

    logger.flush();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes nothing while held and leaves the queue for release", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 2);

    logger.flush();

    expect(app.calls).toEqual([]);
  });

  it("writes the kept queue on release after a flush while held", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 2);
    logger.flush();

    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual([lineMessage(1), lineMessage(2)]);
  });

  it("queues the summaries of open windows while held", () => {
    const { app, logger } = setup();
    const fields = { component: "connector", key: "reconnect" };
    logger.log("warn", "hub unreachable", fields);
    logger.log("warn", "hub unreachable", fields);
    logger.hold();

    logger.flush();

    expect(app.calls).toHaveLength(1);
  });

  it("writes the summaries queued by a flush while held after release", () => {
    const { app, logger } = setup();
    const fields = { component: "connector", key: "reconnect" };
    logger.log("warn", "hub unreachable", fields);
    logger.log("warn", "hub unreachable", fields);
    logger.hold();
    logger.flush();

    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual([
      "[probex] connector: hub unreachable",
      "[probex] connector: hub unreachable (repeated 1 times in 0 s)",
    ]);
  });

  it("writes the queue before the summaries of open windows", () => {
    const { app, logger } = setup();
    const fields = { component: "connector", key: "reconnect" };
    logger.log("warn", "hub unreachable", fields);
    logger.log("warn", "hub unreachable", fields);
    logger.hold();
    logger.log("warn", "snapshot failed", { component: "debugger" });
    logger.release();

    logger.flush();

    expect(messages(app.calls)).toEqual([
      "[probex] connector: hub unreachable",
      "[probex] debugger: snapshot failed",
      "[probex] connector: hub unreachable (repeated 1 times in 0 s)",
    ]);
  });

  it("keeps the immediate while another logger's queue still waits", () => {
    const first = setup();
    const second = setup("warn", "connector");
    first.logger.hold();
    first.logger.log("warn", "snapshot failed", { component: "debugger" });
    second.logger.log("warn", "hub unreachable", { component: "connector" });
    first.logger.release();

    first.logger.flush();
    runImmediates();

    expect(messages(second.app.calls)).toEqual(["[probex] connector: hub unreachable"]);
  });

  it("writes only its own logger's queue", () => {
    const first = setup();
    const second = setup("warn", "connector");
    first.logger.hold();
    first.logger.log("warn", "snapshot failed", { component: "debugger" });
    second.logger.log("warn", "hub unreachable", { component: "connector" });
    first.logger.release();

    first.logger.flush();

    expect([messages(first.app.calls), second.app.calls]).toEqual([["[probex] debugger: snapshot failed"], []]);
  });
});

describe("records of other copies", () => {
  it("writes a queue left behind when another copy clears the flag, with the next line", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 1);
    Reflect.set(Reflect.get(globalThis, HOLD_KEY), "held", false);

    writeLines(logger, 2, 2);
    runImmediates();

    expect(messages(app.calls)).toEqual([lineMessage(1), lineMessage(2)]);
  });

  it("keeps a drains field of another shape as it is", () => {
    const { logger } = setup();
    const drains = ["drain of another copy"];
    Reflect.set(globalThis, HOLD_KEY, { held: true, drains });

    writeLines(logger, 1, 1);

    expect(Reflect.get(Reflect.get(globalThis, HOLD_KEY), "drains")).toBe(drains);
  });

  it("writes its queue on release when the drains field has another shape", () => {
    const { app, logger } = setup();
    Reflect.set(globalThis, HOLD_KEY, { held: true, drains: ["drain of another copy"] });
    writeLines(logger, 1, 1);

    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual([lineMessage(1)]);
  });

  it("still writes the other queues when a drain of another copy throws", () => {
    const { app, logger } = setup();
    const failingDrain = (): never => {
      throw new Error("drain of another copy");
    };
    Reflect.set(globalThis, HOLD_KEY, { held: true, drains: new Set([failingDrain]) });
    writeLines(logger, 1, 1);

    logger.release();
    runImmediates();

    expect(messages(app.calls)).toEqual([lineMessage(1)]);
  });

  it("keeps at most 100 lines under a frozen held record", () => {
    const { app, logger } = setup();
    Reflect.set(globalThis, HOLD_KEY, Object.freeze({ held: true, drains: new Set() }));
    writeLines(logger, 1, 105);
    logger.release();
    runImmediates();
    Reflect.deleteProperty(globalThis, HOLD_KEY);

    logger.flush();

    expect(app.calls).toHaveLength(101);
  });
});

describe("cleanup", () => {
  it("leaves no drain registered after the queue is written", () => {
    const { logger } = setup();
    logger.hold();
    writeLines(logger, 1, 1);
    logger.release();

    runImmediates();

    expect(Reflect.get(Reflect.get(globalThis, HOLD_KEY), "drains")).toEqual(new Set());
  });

  it("leaves no timer behind once the queue is written", () => {
    const { logger } = setup();
    logger.hold();
    writeLines(logger, 1, 1);
    logger.release();

    runImmediates();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the count of dropped lines anew in the next pause", () => {
    const { app, logger } = setup();
    logger.hold();
    writeLines(logger, 1, 101);
    logger.release();
    runImmediates();
    logger.hold();
    logger.log("warn", "hub unreachable", { component: "connector" });
    writeLines(logger, 1, 101);

    logger.release();
    runImmediates();

    expect(app.calls.at(-1)).toEqual([
      "warn",
      "[probex] connector: log lines dropped while the thread was paused: 2",
      { component: "connector" },
    ]);
  });
});

describe("app logger during the pause", () => {
  it("writes the queue to the logger set during the pause", () => {
    const { app, logger } = setup();
    const replacement = createRecorder();
    logger.hold();
    writeLines(logger, 1, 1);

    logger.set({ logger: replacement.logger, logLevel: "warn" }, "debugger");
    logger.release();
    runImmediates();

    expect([app.calls, messages(replacement.calls)]).toEqual([[], [lineMessage(1)]]);
  });

  it("causes no unhandled rejection when the app's logger rejects during the drain", async () => {
    const logger = createLogger({ component: "debugger", env: {}, console: createRecorder().logger });
    const reject = (): unknown => Promise.reject(new Error("transport closed"));
    logger.set({ logger: { debug: reject, info: reject, warn: reject, error: reject }, logLevel: "warn" }, "debugger");
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    logger.hold();
    writeLines(logger, 1, 1);
    logger.release();

    runImmediates();
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onRejection);

    expect(rejections).toEqual([]);
  });
});
