import { resolveOptions, type ResolvedConnectorOptions } from "./options.js";
import { isRecord, readField, readOption, type Warn } from "./read-field.js";
import { createLogger, SdkLogger, type Environment, type Logger } from "../../logger/index.js";

/** The key under which the debugger hands its logger to the `HubConnector` it creates; not in `HubConnectorOptions`. */
export const LOGGER_KEY: unique symbol = Symbol.for("probex.logger");

/** The connector's options and logger, resolved once when it is created. */
export interface ConnectorConfig {
  options: ResolvedConnectorOptions;
  logger: SdkLogger;
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
    warn('the value under Symbol.for("probex.logger") is not an SDK logger; it is ignored');
  }

  const logger = createLogger({ component: COMPONENT, env, console: fallback });
  logger.set(
    { logger: readOption(options, "logger", warn), logLevel: readOption(options, "logLevel", warn) },
    COMPONENT,
  );
  return logger;
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

  return { options: resolveOptions(fields, { env, warn }), logger };
};
