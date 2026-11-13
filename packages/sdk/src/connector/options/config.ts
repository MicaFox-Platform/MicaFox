import { resolveOptions, type ResolvedConnectorOptions } from "./options.js";
import { isRecord, readField, readOption, type Warn } from "./read-field.js";
import { createLogger, SdkLogger, type Environment, type Logger } from "../../logger/index.js";

/** The key under which the debugger hands its logger to the `HubConnector` it creates; not in `HubConnectorOptions`. */
export const LOGGER_KEY: unique symbol = Symbol.for("micafox.logger");

/**
 * The key under which the debugger hands the modules it runs to the `HubConnector` it creates, which sends them in
 * `hello`; not in `HubConnectorOptions`.
 */
export const MODULES_KEY: unique symbol = Symbol.for("micafox.modules");

/** The modules a `HubConnector` sends in `hello` when the app created it, or when the SDK handed over something else. */
const DEFAULT_MODULES: readonly string[] = ["debugger"];

/** The connector's options, logger and modules, resolved once when it is created. */
export interface ConnectorConfig {
  options: ResolvedConnectorOptions;
  logger: SdkLogger;
  /** The modules `hello` lists. */
  modules: string[];
}

/** What `resolveConnectorConfig()` needs from outside. */
export interface ConnectorDependencies {
  env?: Environment;
  /** Where the connector's own logger writes when the app passes no `logger`. */
  console?: Logger;
}

const COMPONENT = "connector";

// Only the SDK's own logger is accepted: it never throws or rejects, while any object the app puts under the
// public symbol could
const isSdkLogger = (value: unknown): value is SdkLogger => {
  try {
    return value instanceof SdkLogger;
  } catch {
    // A Proxy whose getPrototypeOf trap throws
    return false;
  }
};

// The debugger's logger when it handed one over, so one logger serves both; otherwise the connector's own, built
// from `logger` and `logLevel` (docs/architecture/sdk/logger.md#interactions)
const chooseLogger = (
  options: object | undefined,
  { env, console: fallback }: Required<ConnectorDependencies>,
  warn: Warn,
): SdkLogger => {
  const handed = readField(options, LOGGER_KEY, warn);
  if (isSdkLogger(handed)) {
    return handed;
  }

  if (handed !== undefined) {
    warn('the value under Symbol.for("micafox.logger") is not an SDK logger; it is ignored');
  }

  const logger = createLogger({ component: COMPONENT, env, console: fallback });
  logger.set(
    { logger: readOption(options, "logger", warn), logLevel: readOption(options, "logLevel", warn) },
    COMPONENT,
  );
  return logger;
};

// A copy of `value` when it is a non-empty array of strings. Reading it may throw when it is a Proxy or has a getter;
// Array.from turns a hole into `undefined`, which `every` would skip.
const copyModuleList = (value: unknown): string[] | undefined => {
  try {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const entries: unknown[] = Array.from(value);
    return entries.length > 0 && entries.every((entry): entry is string => typeof entry === "string")
      ? entries
      : undefined;
  } catch {
    return undefined;
  }
};

// Anything but a non-empty array of strings falls back to the default
const chooseModules = (options: object | undefined, warn: Warn): string[] => {
  const handed = readField(options, MODULES_KEY, warn);
  if (handed === undefined) {
    return [...DEFAULT_MODULES];
  }

  const modules = copyModuleList(handed);
  if (modules === undefined) {
    warn('the value under Symbol.for("micafox.modules") is not a non-empty array of strings; using ["debugger"]');
    return [...DEFAULT_MODULES];
  }

  return modules;
};

/**
 * Resolves `HubConnectorOptions` and sets up the connector's logger. Never throws: an invalid value logs a warning
 * and its default is used. Changes to `env` or to the options afterwards have no effect.
 */
export const resolveConnectorConfig = (
  options: unknown,
  { env = process.env, console: fallback = console }: ConnectorDependencies = {},
): ConnectorConfig => {
  // Warnings found before the logger exists wait for it
  const early: string[] = [];
  const keepEarly: Warn = (message) => {
    early.push(message);
  };

  const fields = isRecord(options) ? options : undefined;
  if (options !== undefined && fields === undefined) {
    keepEarly("options must be an object; using the defaults");
  }

  const logger = chooseLogger(fields, { env, console: fallback }, keepEarly);
  const warn: Warn = (message) => {
    logger.log("warn", message, { component: COMPONENT });
  };

  for (const message of early) {
    warn(message);
  }

  return { options: resolveOptions(fields, { env, warn }), logger, modules: chooseModules(fields, warn) };
};
