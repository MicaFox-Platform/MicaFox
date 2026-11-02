import { Console } from "node:console";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../index.js";

// A real Node console writing to a string, to check how util.format treats what the logger passes
const createNodeConsole = (): { console: Console; read: () => string } => {
  let output = "";
  const stream = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      output += chunk.toString();
      callback();
    },
  });
  return { console: new Console({ stdout: stream, stderr: stream }), read: () => output };
};

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

const setup = (envLogLevel?: string) => {
  const env = Object.fromEntries(envLogLevel === undefined ? [] : [["PROBEX_LOG_LEVEL", envLogLevel]]);
  const app = createRecorder();
  const fallback = createRecorder();
  const logger = createLogger({ component: "debugger", env, console: fallback.logger });
  return { app, fallback, logger };
};

const createThrowingLogger = (): Logger => {
  const fail = (): never => {
    throw new Error("transport closed");
  };
  return { debug: fail, info: fail, warn: fail, error: fail };
};

const createReturningLogger = (result: () => unknown): Logger => {
  const write = (): unknown => result();
  return { debug: write, info: write, warn: write, error: write };
};

const collectUnhandledRejections = async (act: () => void): Promise<unknown[]> => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    act();
    // Unhandled rejections are reported after the microtask queue drains
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return rejections;
};

describe("defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads process.env and writes to the global console when none is injected", () => {
    vi.stubEnv("PROBEX_LOG_LEVEL", "debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = createLogger({ component: "debugger" });

    logger.log("debug", "breakpoint resolved", { component: "debugger" });

    expect(debug.mock.calls).toEqual([["[probex] debugger: breakpoint resolved"]]);
  });
});

describe("set", () => {
  it("uses the logLevel option over PROBEX_LOG_LEVEL", () => {
    const { app, logger } = setup("error");

    logger.set({ logger: app.logger, logLevel: "debug" }, "debugger");

    expect(logger.enabled("debug")).toBe(true);
  });

  it("uses PROBEX_LOG_LEVEL when no logLevel is passed", () => {
    const { logger } = setup("error");

    logger.set({}, "debugger");

    expect(logger.enabled("warn")).toBe(false);
  });

  it("uses warn when neither the option nor PROBEX_LOG_LEVEL is set", () => {
    const { logger } = setup();

    logger.set({}, "debugger");

    expect([logger.enabled("info"), logger.enabled("warn")]).toEqual([false, true]);
  });

  it("treats an empty PROBEX_LOG_LEVEL as unset", () => {
    const { fallback, logger } = setup("");

    logger.set({}, "debugger");

    expect([logger.enabled("info"), logger.enabled("warn"), fallback.calls]).toEqual([false, true, []]);
  });

  it("writes to console when no logger is passed", () => {
    const { fallback, logger } = setup();
    logger.set({}, "connector");

    logger.log("warn", "hub unreachable", { component: "connector" });

    expect(fallback.calls).toEqual([["warn", "[probex] connector: hub unreachable"]]);
  });

  it("reads PROBEX_LOG_LEVEL when the first line is written if set() was never called", () => {
    const env: Record<string, string | undefined> = {};
    const fallback = createRecorder();
    const logger = createLogger({ component: "debugger", env, console: fallback.logger });
    Reflect.set(env, "PROBEX_LOG_LEVEL", "debug");

    logger.log("debug", "breakpoint resolved", { component: "debugger" });

    expect(fallback.calls).toEqual([["debug", "[probex] debugger: breakpoint resolved"]]);
  });
});

describe("invalid options", () => {
  it("warns once with the caller's component and uses warn when logLevel is invalid", () => {
    const { app, logger } = setup("debug");

    logger.set({ logger: app.logger, logLevel: "verbose" }, "connector");

    expect(app.calls).toEqual([
      [
        "warn",
        "[probex] connector: logLevel must be one of debug, info, warn, error or silent; using warn",
        { component: "connector" },
      ],
    ]);
    expect(logger.enabled("info")).toBe(false);
  });

  it("warns once with the caller's component and uses warn when PROBEX_LOG_LEVEL is invalid", () => {
    const { app, logger } = setup("DEBUG");

    logger.set({ logger: app.logger }, "connector");

    expect(app.calls).toEqual([
      [
        "warn",
        "[probex] connector: PROBEX_LOG_LEVEL must be one of debug, info, warn, error or silent; using warn",
        { component: "connector" },
      ],
    ]);
    expect(logger.enabled("debug")).toBe(false);
  });

  it("warns to console with the caller's component and uses console when logger lacks a method", () => {
    const { fallback, logger } = setup();

    logger.set({ logger: { warn: () => undefined, error: () => undefined } }, "connector");
    logger.log("error", "token rejected", { component: "connector" });

    expect(fallback.calls).toEqual([
      ["warn", "[probex] connector: logger must be an object with debug, info, warn and error methods; using console"],
      ["error", "[probex] connector: token rejected"],
    ]);
  });

  it("writes no logger warning when the level drops warn", () => {
    const { fallback, logger } = setup();

    logger.set({ logger: {}, logLevel: "error" }, "debugger");

    expect(fallback.calls).toEqual([]);
  });

  it("writes both warnings to console when logLevel and logger are invalid", () => {
    const { fallback, logger } = setup();

    logger.set({ logger: {}, logLevel: "verbose" }, "connector");

    expect(fallback.calls).toEqual([
      ["warn", "[probex] connector: logLevel must be one of debug, info, warn, error or silent; using warn"],
      ["warn", "[probex] connector: logger must be an object with debug, info, warn and error methods; using console"],
    ]);
  });

  it("goes back to the default console when a later set() passes no logger", () => {
    const { app, fallback, logger } = setup();
    logger.set({ logger: app.logger }, "debugger");
    logger.set({}, "debugger");

    logger.log("warn", "50% of the buffer used", { component: "debugger" });

    expect([app.calls, fallback.calls]).toEqual([[], [["warn", "[probex] debugger: 50% of the buffer used"]]]);
  });

  it("warns and uses console when logger is null", () => {
    const { fallback, logger } = setup();

    logger.set({ logger: null }, "debugger");
    logger.log("error", "debugger stopped", { component: "debugger" });

    expect(fallback.calls).toEqual([
      ["warn", "[probex] debugger: logger must be an object with debug, info, warn and error methods; using console"],
      ["error", "[probex] debugger: debugger stopped"],
    ]);
  });

  it("warns and uses console when reading a logger method throws", () => {
    const { fallback, logger } = setup();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("no access");
        },
      },
    );

    logger.set({ logger: hostile }, "debugger");
    logger.log("error", "debugger stopped", { component: "debugger" });

    expect(fallback.calls).toEqual([
      ["warn", "[probex] debugger: logger must be an object with debug, info, warn and error methods; using console"],
      ["error", "[probex] debugger: debugger stopped"],
    ]);
  });

  it("accepts a callable logger that carries the four methods", () => {
    const { app, fallback, logger } = setup();
    const callable = Object.assign(() => undefined, app.logger);

    logger.set({ logger: callable }, "debugger");
    logger.log("warn", "snapshot dropped", { component: "debugger" });

    expect([fallback.calls, app.calls]).toEqual([
      [],
      [["warn", "[probex] debugger: snapshot dropped", { component: "debugger" }]],
    ]);
  });

  it("warns about PROBEX_LOG_LEVEL with the owner's component before set() is called", () => {
    const fallback = createRecorder();
    const env = Object.fromEntries([["PROBEX_LOG_LEVEL", "verbose"]]);
    const logger = createLogger({ component: "connector", env, console: fallback.logger });

    logger.enabled("debug");

    expect(fallback.calls).toEqual([
      ["warn", "[probex] connector: PROBEX_LOG_LEVEL must be one of debug, info, warn, error or silent; using warn"],
    ]);
  });

  it("warns about PROBEX_LOG_LEVEL only once per logger", () => {
    const { fallback, logger } = setup("verbose");

    logger.log("warn", "configure() ignored while running", { component: "debugger" });
    logger.set({}, "connector");
    logger.set({}, "connector");

    expect(fallback.calls).toEqual([
      ["warn", "[probex] debugger: PROBEX_LOG_LEVEL must be one of debug, info, warn, error or silent; using warn"],
      ["warn", "[probex] debugger: configure() ignored while running"],
    ]);
  });
});

describe("level filter", () => {
  it.each([
    ["debug", false],
    ["info", false],
    ["warn", true],
    ["error", true],
  ] as const)("tells whether %s is enabled at warn", (level, isEnabled) => {
    const { logger } = setup();

    logger.set({}, "debugger");

    expect(logger.enabled(level)).toBe(isEnabled);
  });

  it("writes nothing when the level is silent", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger, logLevel: "silent" }, "debugger");

    logger.log("error", "debugger stopped", { component: "debugger" });

    expect([logger.enabled("error"), app.calls]).toEqual([false, []]);
  });

  it("drops a line below the level without reaching the app's logger or reading its error", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "debugger");
    let isErrorRead = false;
    const fields = {
      component: "debugger",
      get error(): unknown {
        isErrorRead = true;
        return new Error("unused");
      },
    };

    logger.log("info", "breakpoint set", fields);

    expect([app.calls, isErrorRead]).toEqual([[], false]);
  });
});

describe("message", () => {
  it("prefixes the message with probex and the component", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "connector");

    logger.log("warn", "hub unreachable, retrying in 4 s", { component: "connector" });

    expect(app.calls[0]?.[1]).toBe("[probex] connector: hub unreachable, retrying in 4 s");
  });

  it("passes % as is to a passed logger", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "connector");

    logger.log("warn", "GET /orders%20new failed: %s %o", { component: "connector" });

    expect(app.calls[0]?.[1]).toBe("[probex] connector: GET /orders%20new failed: %s %o");
  });

  it("passes % as is to the default console, which prints a single argument unformatted", () => {
    const { fallback, logger } = setup();
    logger.set({}, "connector");

    logger.log("warn", "GET /orders%20new failed: %s", { component: "connector" });

    expect(fallback.calls).toEqual([["warn", "[probex] connector: GET /orders%20new failed: %s"]]);
  });

  it("prints % as written through a real default console", () => {
    const nodeConsole = createNodeConsole();
    const logger = createLogger({ component: "connector", env: {}, console: nodeConsole.console });

    logger.log("warn", "GET /orders%20new failed: %s", { component: "connector" });

    expect(nodeConsole.read()).toBe("[probex] connector: GET /orders%20new failed: %s\n");
  });

  it("lets a %s in the message take the context through a real passed console", () => {
    const nodeConsole = createNodeConsole();
    const logger = createLogger({ component: "connector", env: {}, console: nodeConsole.console });
    logger.set({ logger: nodeConsole.console }, "connector");

    logger.log("warn", "GET /orders%20new failed: %s", { component: "connector" });

    expect(nodeConsole.read()).toBe("[probex] connector: GET /orders%20new failed: { component: 'connector' }\n");
  });

  it("calls a passed logger's method with this bound to it", () => {
    const { logger } = setup();
    class PrefixLogger implements Logger {
      readonly lines: string[] = [];
      debug(message: string): void {
        this.lines.push(message);
      }
      info(message: string): void {
        this.lines.push(message);
      }
      warn(message: string): void {
        this.lines.push(message);
      }
      error(message: string): void {
        this.lines.push(message);
      }
    }
    const app = new PrefixLogger();
    logger.set({ logger: app }, "debugger");

    logger.log("error", "debugger stopped", { component: "debugger" });

    expect(app.lines).toEqual(["[probex] debugger: debugger stopped"]);
  });

  it("passes the context to a passed console", () => {
    const fakeConsole = createRecorder();
    const logger = createLogger({ component: "debugger", env: {}, console: fakeConsole.logger });
    logger.set({ logger: fakeConsole.logger }, "debugger");

    logger.log("warn", "snapshot dropped", { component: "debugger", breakpointId: "bp-1" });

    expect(fakeConsole.calls).toEqual([
      ["warn", "[probex] debugger: snapshot dropped", { component: "debugger", breakpointId: "bp-1" }],
    ]);
  });

  it("passes the full message first and the context second to a pino-style logger", () => {
    const { logger } = setup();
    const received: unknown[][] = [];
    const write = (objOrMessage: object | string, ...args: unknown[]): void => {
      received.push([objOrMessage, ...args]);
    };
    logger.set({ logger: { debug: write, info: write, warn: write, error: write } }, "connector");

    logger.log("warn", "hub unreachable", { component: "connector" });

    expect(received).toEqual([["[probex] connector: hub unreachable", { component: "connector" }]]);
  });

  it("passes the full message first and the context second to a winston-style logger", () => {
    const { logger } = setup();
    const received: unknown[][] = [];
    const write = (message: string, meta?: object): void => {
      received.push([message, meta]);
    };
    logger.set({ logger: { debug: write, info: write, warn: write, error: write } }, "connector");

    logger.log("error", "token rejected", { component: "connector" });

    expect(received).toEqual([["[probex] connector: token rejected", { component: "connector" }]]);
  });
});

describe("context", () => {
  const logError = (error: unknown): unknown => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "debugger");
    logger.log("warn", "snapshot failed", { component: "debugger", error });
    return app.calls[0]?.[2];
  };

  it("survives a JSON round trip", () => {
    const context = logError(Object.assign(new TypeError("bad frame"), { code: 42 }));

    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
  });

  it("turns an Error into its name, message, code as a string and stack", () => {
    const error = Object.assign(new TypeError("bad frame"), { code: 42 });

    const context = logError(error);

    expect(context).toEqual({
      component: "debugger",
      error: { name: "TypeError", message: "bad frame", code: "42", stack: error.stack },
    });
  });

  it("falls back when the Error's fields are not strings and its code is null", () => {
    const error = new Error("bad frame");
    Object.defineProperties(error, {
      name: { value: 42 },
      message: { value: {} },
      stack: { value: 1 },
      code: { value: null },
    });

    const context = logError(error);

    expect(context).toEqual({ component: "debugger", error: { name: "Error", message: "" } });
  });

  it("omits code and stack when the Error has none", () => {
    const error = new Error("bad frame");
    Object.defineProperty(error, "stack", { value: undefined });

    const context = logError(error);

    expect(context).toEqual({ component: "debugger", error: { name: "Error", message: "bad frame" } });
  });

  it.each([
    ["a string", "boom", "boom"],
    ["a number", 42, "42"],
    ["null", null, "null"],
  ])("turns a thrown non-Error such as %s into a NonError", (_kind, value, message) => {
    const context = logError(value);

    expect(context).toEqual({ component: "debugger", error: { name: "NonError", message } });
  });

  it("describes an Error whose getters throw without throwing", () => {
    const error = new Error("bad frame");
    const fail = (): never => {
      throw new Error("getter");
    };
    Object.defineProperties(error, { name: { get: fail }, message: { get: fail }, stack: { get: fail } });
    Object.defineProperty(error, "code", { get: fail });

    const context = logError(error);

    expect(context).toEqual({ component: "debugger", error: { name: "Error", message: "" } });
  });

  it("describes a non-Error whose toString throws without throwing", () => {
    const value = {
      toString: (): string => {
        throw new Error("toString");
      },
    };

    const context = logError(value);

    expect(context).toEqual({
      component: "debugger",
      error: { name: "NonError", message: "[value cannot be converted to a string]" },
    });
  });

  it("describes a Proxy whose traps throw without throwing", () => {
    const fail = (): never => {
      throw new Error("trap");
    };
    const value = new Proxy({}, { get: fail, getPrototypeOf: fail });

    const context = logError(value);

    expect(context).toEqual({
      component: "debugger",
      error: { name: "NonError", message: "[value cannot be converted to a string]" },
    });
  });

  it("keeps breakpointId in the context", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "debugger");

    logger.log("warn", "condition failed", { component: "debugger", breakpointId: "bp-1" });

    expect(app.calls[0]?.[2]).toEqual({ component: "debugger", breakpointId: "bp-1" });
  });
});

describe("safe call", () => {
  it("ignores a logger method that throws and does not log the failure", () => {
    const { fallback, logger } = setup();
    logger.set({ logger: createThrowingLogger() }, "debugger");

    logger.log("error", "debugger stopped", { component: "debugger" });

    expect(fallback.calls).toEqual([]);
  });

  it("ignores a method the app replaced with a non-function after set()", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "debugger");
    Reflect.set(app.logger, "warn", "disabled");

    logger.log("warn", "snapshot dropped", { component: "debugger" });
    logger.log("error", "debugger stopped", { component: "debugger" });

    expect(app.calls).toEqual([["error", "[probex] debugger: debugger stopped", { component: "debugger" }]]);
  });

  it("ignores a method getter that starts throwing after set()", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "debugger");
    Object.defineProperty(app.logger, "warn", {
      get: () => {
        throw new Error("no access");
      },
    });

    expect(() => {
      logger.log("warn", "snapshot dropped", { component: "debugger" });
    }).not.toThrow();
  });

  it("ignores a default console whose method throws", () => {
    const logger = createLogger({ component: "debugger", env: {}, console: createThrowingLogger() });

    expect(() => {
      logger.log("error", "debugger stopped", { component: "debugger" });
    }).not.toThrow();
  });

  it("causes no unhandled rejection when the logger returns a rejected promise", async () => {
    const { logger } = setup();
    logger.set({ logger: createReturningLogger(() => Promise.reject(new Error("disk full"))) }, "debugger");

    const rejections = await collectUnhandledRejections(() => {
      logger.log("error", "debugger stopped", { component: "debugger" });
    });

    expect(rejections).toEqual([]);
  });

  it("causes no unhandled rejection when the logger returns a rejecting thenable", async () => {
    const { logger } = setup();
    // Wraps a promise that has already rejected: only a rejection handler passed to then() can handle it
    const createThenable = (): PromiseLike<unknown> => {
      const rejected = Promise.reject(new Error("disk full"));
      return { then: (onFulfilled, onRejected) => rejected.then(onFulfilled, onRejected) };
    };
    logger.set({ logger: createReturningLogger(createThenable) }, "debugger");

    const rejections = await collectUnhandledRejections(() => {
      logger.log("error", "debugger stopped", { component: "debugger" });
    });

    expect(rejections).toEqual([]);
  });

  it("ignores a returned value whose then getter throws", () => {
    const { logger } = setup();
    const result = {
      get then(): unknown {
        throw new Error("then");
      },
    };
    logger.set({ logger: createReturningLogger(() => result) }, "debugger");

    expect(() => {
      logger.log("error", "debugger stopped", { component: "debugger" });
    }).not.toThrow();
  });
});

describe("flush", () => {
  it("keeps logging lines written after it", () => {
    const { app, logger } = setup();
    logger.set({ logger: app.logger }, "connector");

    logger.flush();
    logger.log("warn", "send() called after close()", { component: "connector" });

    expect(app.calls).toEqual([
      ["warn", "[probex] connector: send() called after close()", { component: "connector" }],
    ]);
  });
});
