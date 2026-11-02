import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, SdkLogger, type Logger } from "../../../logger/index.js";
import { LOGGER_KEY, resolveConnectorConfig } from "../config.js";

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

// Environment variable names are wire names, which object literal keys cannot spell under the naming rules
const envOf = (...entries: Array<[name: string, value: string]>): Record<string, string | undefined> =>
  Object.fromEntries(entries);

// Resolves with a fake console, so warnings of the connector's own logger can be read
const resolve = (options: unknown, env: Record<string, string | undefined> = {}) => {
  const fallback = createRecorder();
  const config = resolveConnectorConfig(options, { env, console: fallback.logger });
  const warnings = fallback.calls.filter(([level]) => level === "warn").map(([, message]) => message);
  return { config, options: config.options, warnings, calls: fallback.calls };
};

const DEFAULT_OPTIONS = {
  url: undefined,
  token: undefined,
  service: undefined,
  labels: {},
  buffer: { maxMessages: 1000, maxBytes: 1_048_576 },
  batch: { maxMessages: 100, maxBytes: 65_536, flushIntervalMs: 100 },
  rateLimit: { bytesPerSecond: 1_048_576 },
  reconnect: { minDelayMs: 1000, maxDelayMs: 30_000 },
  closeTimeoutMs: 5000,
};

const throwingProxy = (): object =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error("getter failed");
      },
    },
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveConnectorConfig options", () => {
  it("uses the documented defaults when nothing is passed or set", () => {
    const { options, warnings } = resolve(undefined);

    expect({ options, warnings }).toEqual({ options: DEFAULT_OPTIONS, warnings: [] });
  });

  it("takes url, token and service from the environment when they are not passed", () => {
    const env = envOf(
      ["PROBEX_HUB_URL", "wss://hub.example.com/probex"],
      ["PROBEX_TOKEN", "t-env"],
      ["PROBEX_SERVICE", "checkout"],
    );

    const { options } = resolve({}, env);

    expect(options).toMatchObject({ url: "wss://hub.example.com/probex", token: "t-env", service: "checkout" });
  });

  it("prefers passed url, token and service over the environment", () => {
    const env = envOf(
      ["PROBEX_HUB_URL", "wss://env.example.com"],
      ["PROBEX_TOKEN", "t-env"],
      ["PROBEX_SERVICE", "env-service"],
    );

    const { options } = resolve({ url: "ws://localhost:7070", token: "t-code", service: "checkout" }, env);

    expect(options).toMatchObject({ url: "ws://localhost:7070", token: "t-code", service: "checkout" });
  });

  it("treats an empty passed string as unset and falls back to the environment", () => {
    const { options } = resolve({ url: "", service: "" }, envOf(["PROBEX_HUB_URL", "wss://hub.example.com"]));

    expect(options).toMatchObject({ url: "wss://hub.example.com", service: undefined });
  });

  it("treats an empty environment variable as unset", () => {
    const { options } = resolve({}, envOf(["PROBEX_HUB_URL", ""], ["PROBEX_TOKEN", ""]));

    expect(options).toMatchObject({ url: undefined, token: undefined });
  });

  it("keeps the values resolved at creation when the environment changes later", () => {
    const env = envOf(["PROBEX_HUB_URL", "wss://first.example.com"]);
    const { options } = resolve({}, env);

    env.PROBEX_HUB_URL = "wss://second.example.com";

    expect(options.url).toBe("wss://first.example.com");
  });

  it("uses passed number options that are integers of at least 1", () => {
    const passed = {
      buffer: { maxMessages: 1, maxBytes: 2048 },
      batch: { maxMessages: 10, maxBytes: 4096, flushIntervalMs: 250 },
      rateLimit: { bytesPerSecond: 65_536 },
      reconnect: { minDelayMs: 500, maxDelayMs: 500 },
      closeTimeoutMs: 1000,
    };

    const { options, warnings } = resolve(passed);

    expect({ options, warnings }).toEqual({ options: { ...DEFAULT_OPTIONS, ...passed }, warnings: [] });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100", null, true])(
    "warns and uses the default when a number option is %s",
    (value) => {
      const { options, warnings } = resolve({ batch: { maxBytes: value } });

      expect({ maxBytes: options.batch.maxBytes, warnings }).toEqual({
        maxBytes: 65_536,
        warnings: ["[probex] connector: batch.maxBytes must be an integer of at least 1; using 65536"],
      });
    },
  );

  it("warns and uses the default when closeTimeoutMs is not an integer", () => {
    const { options, warnings } = resolve({ closeTimeoutMs: 2.5 });

    expect({ closeTimeoutMs: options.closeTimeoutMs, warnings }).toEqual({
      closeTimeoutMs: 5000,
      warnings: ["[probex] connector: closeTimeoutMs must be an integer of at least 1; using 5000"],
    });
  });

  it("warns and uses the group's defaults when a group is not an object", () => {
    const { options, warnings } = resolve({ buffer: 500 });

    expect({ buffer: options.buffer, warnings }).toEqual({
      buffer: DEFAULT_OPTIONS.buffer,
      warnings: ["[probex] connector: buffer must be an object; using its defaults"],
    });
  });

  it("warns and uses both defaults when reconnect.minDelayMs exceeds reconnect.maxDelayMs", () => {
    const { options, warnings } = resolve({ reconnect: { minDelayMs: 5000, maxDelayMs: 2000 } });

    expect({ reconnect: options.reconnect, warnings }).toEqual({
      reconnect: { minDelayMs: 1000, maxDelayMs: 30_000 },
      warnings: ["[probex] connector: reconnect.minDelayMs must not exceed reconnect.maxDelayMs; using 1000 and 30000"],
    });
  });

  it("checks reconnect delays against each other after replacing an invalid one by its default", () => {
    const { options, warnings } = resolve({ reconnect: { minDelayMs: 40_000, maxDelayMs: -1 } });

    expect({ reconnect: options.reconnect, warnings }).toEqual({
      reconnect: { minDelayMs: 1000, maxDelayMs: 30_000 },
      warnings: [
        "[probex] connector: reconnect.maxDelayMs must be an integer of at least 1; using 30000",
        "[probex] connector: reconnect.minDelayMs must not exceed reconnect.maxDelayMs; using 1000 and 30000",
      ],
    });
  });

  it("warns without the value and ignores the environment when a string option has the wrong type", () => {
    const { options, warnings } = resolve({ token: 12_345 }, envOf(["PROBEX_TOKEN", "t-env"]));

    expect({ token: options.token, warnings }).toEqual({
      token: undefined,
      warnings: ["[probex] connector: token must be a string; it is ignored"],
    });
  });

  it.each([
    ["url", 42, "PROBEX_HUB_URL"],
    ["service", {}, "PROBEX_SERVICE"],
  ])("leaves %s unset with a warning when it has the wrong type", (name, value, envName) => {
    const { options, warnings } = resolve({ [name]: value }, envOf([envName, "from-env"]));

    expect({ value: options[name as "url" | "service"], warnings }).toEqual({
      value: undefined,
      warnings: [`[probex] connector: ${name} must be a string; it is ignored`],
    });
  });

  it("treats an empty string as unset for a number option and a group", () => {
    const { options, warnings } = resolve({ buffer: "", batch: { maxBytes: "" } });

    expect({ buffer: options.buffer, batch: options.batch, warnings }).toEqual({
      buffer: DEFAULT_OPTIONS.buffer,
      batch: DEFAULT_OPTIONS.batch,
      warnings: [],
    });
  });

  it.each(["wss://hub.example.com", 42, null])("warns and uses the defaults when the options are %s", (value) => {
    const { options, warnings } = resolve(value);

    expect({ options, warnings }).toEqual({
      options: DEFAULT_OPTIONS,
      warnings: ["[probex] connector: options must be an object; using the defaults"],
    });
  });
});

describe("resolveConnectorConfig with hostile options", () => {
  it("does not throw and uses the defaults when every getter throws", () => {
    const { options, warnings } = resolve(throwingProxy());

    expect({ options, warnings }).toEqual({
      options: DEFAULT_OPTIONS,
      warnings: [
        "Symbol(probex.logger)",
        "logger",
        "logLevel",
        "buffer",
        "batch",
        "rateLimit",
        "url",
        "token",
        "service",
        "labels",
        "reconnect",
        "closeTimeoutMs",
      ].map((name) => `[probex] connector: ${name} could not be read; it is ignored`),
    });
  });

  it("warns and uses the default when one option's getter throws", () => {
    const passed = {
      get url(): string {
        throw new Error("getter failed");
      },
    };

    const { options, warnings } = resolve(passed, envOf(["PROBEX_HUB_URL", "wss://hub.example.com"]));

    expect({ url: options.url, warnings }).toEqual({
      url: "wss://hub.example.com",
      warnings: ["[probex] connector: url could not be read; it is ignored"],
    });
  });

  it("warns with the group's path when a nested getter throws", () => {
    const { options, warnings } = resolve({ batch: throwingProxy() });

    expect({ batch: options.batch, warnings }).toEqual({
      batch: DEFAULT_OPTIONS.batch,
      warnings: [
        "[probex] connector: batch.maxMessages could not be read; it is ignored",
        "[probex] connector: batch.maxBytes could not be read; it is ignored",
        "[probex] connector: batch.flushIntervalMs could not be read; it is ignored",
      ],
    });
  });

  it("does not throw when the options are a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const { options } = resolve(proxy);

    expect(options).toEqual(DEFAULT_OPTIONS);
  });
});

describe("resolveConnectorConfig labels", () => {
  it("parses PROBEX_LABELS, trimming entries and splitting at the first =", () => {
    const { options, warnings } = resolve({}, envOf(["PROBEX_LABELS", " team = payments ,region=eu,a=b=c"]));

    expect({ labels: options.labels, warnings }).toEqual({
      labels: { team: "payments", region: "eu", a: "b=c" },
      warnings: [],
    });
  });

  it("skips PROBEX_LABELS entries without = or with an empty key, naming them only by position", () => {
    const { options, warnings } = resolve({}, envOf(["PROBEX_LABELS", "team=payments,secret-value, =eu"]));

    expect({ labels: options.labels, warnings }).toEqual({
      labels: { team: "payments" },
      warnings: [
        '[probex] connector: PROBEX_LABELS entry 2 has no "="; skipped',
        "[probex] connector: PROBEX_LABELS entry 3 has an empty key; skipped",
      ],
    });
  });

  it("keeps the later value of a repeated PROBEX_LABELS key", () => {
    const { options } = resolve({}, envOf(["PROBEX_LABELS", "region=us,team=payments,region=eu"]));

    expect(options.labels).toEqual({ region: "eu", team: "payments" });
  });

  it("ignores empty PROBEX_LABELS entries from a trailing or doubled comma without a warning", () => {
    const { options, warnings } = resolve({}, envOf(["PROBEX_LABELS", "team=payments,,region=eu,"]));

    expect({ labels: options.labels, warnings }).toEqual({ labels: { team: "payments", region: "eu" }, warnings: [] });
  });

  it("keeps a __proto__ key as a plain label without changing the prototype", () => {
    const { options } = resolve({}, envOf(["PROBEX_LABELS", "__proto__=x"]));

    const prototype: unknown = Object.getPrototypeOf(options.labels);

    expect({ own: Object.keys(options.labels), prototype }).toEqual({
      own: ["__proto__"],
      prototype: Object.prototype,
    });
  });

  it("keeps an empty value and skips a blank entry in PROBEX_LABELS", () => {
    const { options, warnings } = resolve({}, envOf(["PROBEX_LABELS", " , team=,region=eu"]));

    expect({ labels: options.labels, warnings }).toEqual({ labels: { team: "", region: "eu" }, warnings: [] });
  });

  it("uses no labels when an empty labels object is passed, even with PROBEX_LABELS set", () => {
    const { options, warnings } = resolve({ labels: {} }, envOf(["PROBEX_LABELS", "team=payments"]));

    expect({ labels: options.labels, warnings }).toEqual({ labels: {}, warnings: [] });
  });

  it("uses PROBEX_LABELS when labels is an empty string", () => {
    const { options } = resolve({ labels: "" }, envOf(["PROBEX_LABELS", "team=payments"]));

    expect(options.labels).toEqual({ team: "payments" });
  });

  it("skips a passed label whose value is undefined without a warning", () => {
    const { options, warnings } = resolve({ labels: { region: "eu", team: undefined } });

    expect({ labels: options.labels, warnings }).toEqual({ labels: { region: "eu" }, warnings: [] });
  });

  it("keeps a passed own __proto__ label without changing the prototype", () => {
    const labels: unknown = JSON.parse('{"__proto__":"x"}');

    const { options } = resolve({ labels });
    const prototype: unknown = Object.getPrototypeOf(options.labels);

    expect({ own: Object.keys(options.labels), prototype }).toEqual({
      own: ["__proto__"],
      prototype: Object.prototype,
    });
  });

  it("replaces PROBEX_LABELS with a passed labels object", () => {
    const { options } = resolve({ labels: { region: "eu" } }, envOf(["PROBEX_LABELS", "team=payments"]));

    expect(options.labels).toEqual({ region: "eu" });
  });

  it("copies passed labels, so later changes to the object have no effect", () => {
    const labels: Record<string, string> = { region: "eu" };
    const { options } = resolve({ labels });

    labels.region = "us";

    expect(options.labels).toEqual({ region: "eu" });
  });

  it("skips passed labels that are not strings or have an empty key", () => {
    const { options, warnings } = resolve({ labels: { region: "eu", shard: 3, "": "x" } });

    expect({ labels: options.labels, warnings }).toEqual({
      labels: { region: "eu" },
      warnings: [
        "[probex] connector: labels.shard must be a string; skipped",
        "[probex] connector: labels has an entry with an empty key; skipped",
      ],
    });
  });

  it("skips a passed label whose getter throws", () => {
    const labels = {
      region: "eu",
      get team(): string {
        throw new Error("getter failed");
      },
    };

    const { options, warnings } = resolve({ labels });

    expect({ labels: options.labels, warnings }).toEqual({
      labels: { region: "eu" },
      warnings: ["[probex] connector: labels.team could not be read; it is ignored"],
    });
  });

  it.each([["team=payments"], [["team"]], [null]])("warns and uses no labels when labels is %j", (labels) => {
    const { options, warnings } = resolve({ labels }, envOf(["PROBEX_LABELS", "team=payments"]));

    expect({ labels: options.labels, warnings }).toEqual({
      labels: {},
      warnings: ["[probex] connector: labels must be an object of strings; using no labels"],
    });
  });

  it("warns and uses no labels when the keys of a passed labels object cannot be listed", () => {
    const labels = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("ownKeys failed");
        },
      },
    );

    const { options, warnings } = resolve({ labels });

    expect({ labels: options.labels, warnings }).toEqual({
      labels: {},
      warnings: ["[probex] connector: labels must be an object of strings; using no labels"],
    });
  });
});

describe("resolveConnectorConfig logger", () => {
  it("uses the handed-over logger and ignores logger and logLevel", () => {
    const debuggerApp = createRecorder();
    const ignoredApp = createRecorder();
    const handed = createLogger({ component: "debugger", env: {}, console: createRecorder().logger });
    handed.set({ logger: debuggerApp.logger }, "debugger");

    const { config } = resolve({
      [LOGGER_KEY]: handed,
      logger: ignoredApp.logger,
      logLevel: "nope",
      closeTimeoutMs: 0,
    });

    expect({ isHanded: config.logger === handed, debuggerApp: debuggerApp.calls, ignored: ignoredApp.calls }).toEqual({
      isHanded: true,
      debuggerApp: [
        [
          "warn",
          "[probex] connector: closeTimeoutMs must be an integer of at least 1; using 5000",
          { component: "connector" },
        ],
      ],
      ignored: [],
    });
  });

  it("builds its own logger from logger and logLevel when none is handed over", () => {
    const app = createRecorder();

    const { config } = resolve({ logger: app.logger, logLevel: "info" });
    config.logger.log("info", "connected to the hub", { component: "connector" });

    expect(app.calls).toEqual([["info", "[probex] connector: connected to the hub", { component: "connector" }]]);
  });

  it("writes its warnings with component connector to the app's logger", () => {
    const app = createRecorder();

    resolve({ logger: app.logger, buffer: "big" });

    expect(app.calls).toEqual([
      ["warn", "[probex] connector: buffer must be an object; using its defaults", { component: "connector" }],
    ]);
  });

  it("warns with component connector when logLevel is invalid", () => {
    const app = createRecorder();

    resolve({ logger: app.logger, logLevel: "verbose" });

    expect(app.calls).toEqual([
      [
        "warn",
        "[probex] connector: logLevel must be one of debug, info, warn, error or silent; using warn",
        { component: "connector" },
      ],
    ]);
  });

  it("takes the level from PROBEX_LOG_LEVEL when logLevel is an empty string", () => {
    const app = createRecorder();

    const { config } = resolve({ logger: app.logger, logLevel: "" }, envOf(["PROBEX_LOG_LEVEL", "debug"]));

    expect(config.logger.enabled("debug")).toBe(true);
  });

  it("keeps the level resolved at creation when PROBEX_LOG_LEVEL changes later", () => {
    const env = envOf(["PROBEX_LOG_LEVEL", "error"]);
    const { config } = resolve({}, env);

    env.PROBEX_LOG_LEVEL = "debug";

    expect(config.logger.enabled("warn")).toBe(false);
  });

  it("ignores a look-alike under the logger key, warns and builds its own logger", () => {
    const app = createRecorder();
    const lookAlike = {
      log: (): Promise<void> => Promise.reject(new Error("async logger failed")),
      enabled: (): boolean => true,
      flush: (): void => undefined,
    };

    const { config } = resolve({ [LOGGER_KEY]: lookAlike, logger: app.logger });

    expect({ isOwn: config.logger instanceof SdkLogger, calls: app.calls }).toEqual({
      isOwn: true,
      calls: [
        [
          "warn",
          '[probex] connector: the value under Symbol.for("probex.logger") is not an SDK logger; it is ignored',
          { component: "connector" },
        ],
      ],
    });
  });

  it("ignores a handed-over Proxy whose prototype cannot be read", () => {
    const app = createRecorder();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("trap failed");
        },
      },
    );

    resolve({ [LOGGER_KEY]: hostile, logger: app.logger });

    expect(app.calls).toEqual([
      [
        "warn",
        '[probex] connector: the value under Symbol.for("probex.logger") is not an SDK logger; it is ignored',
        { component: "connector" },
      ],
    ]);
  });

  it("drops its warnings below the resolved level but still uses the default", () => {
    const app = createRecorder();

    const { options } = resolve({ logger: app.logger, logLevel: "error", closeTimeoutMs: 0 });

    expect({ closeTimeoutMs: options.closeTimeoutMs, calls: app.calls }).toEqual({ closeTimeoutMs: 5000, calls: [] });
  });

  it("writes a warning found before the logger existed to the app's logger", () => {
    const app = createRecorder();
    const passed = {
      logger: app.logger,
      get logLevel(): string {
        throw new Error("getter failed");
      },
    };

    resolve(passed);

    expect(app.calls).toEqual([
      ["warn", "[probex] connector: logLevel could not be read; it is ignored", { component: "connector" }],
    ]);
  });

  it("reads process.env and writes to the global console when no dependencies are given", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("PROBEX_SERVICE", "checkout");

    const { options } = resolveConnectorConfig({ closeTimeoutMs: 0 });

    expect({ service: options.service, warnings: warn.mock.calls }).toEqual({
      service: "checkout",
      warnings: [["[probex] connector: closeTimeoutMs must be an integer of at least 1; using 5000"]],
    });
  });

  it("writes warnings to the default console as the message only", () => {
    const { calls } = resolve({ closeTimeoutMs: 0 });

    expect(calls).toEqual([
      ["warn", "[probex] connector: closeTimeoutMs must be an integer of at least 1; using 5000"],
    ]);
  });
});
