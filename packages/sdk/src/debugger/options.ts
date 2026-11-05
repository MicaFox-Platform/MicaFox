import type { Connector } from "@probex-platform/protocol";

import { isRecord, readEnv, readField, type HubConnectorOptions, type Warn } from "../connector/index.js";
import type { Environment, Logger, LogLevel } from "../logger/index.js";

/** The options of `configure()`; every field is optional. */
export interface DebuggerOptions {
  enabled?: boolean;
  url?: string;
  token?: string;
  service?: string;
  labels?: Record<string, string>;
  redact?: string[];
  logger?: Logger;
  logLevel?: LogLevel;
  hubConnector?: Pick<HubConnectorOptions, "buffer" | "batch" | "rateLimit" | "reconnect" | "closeTimeoutMs">;
  connector?: Connector;
}

type OptionName = keyof DebuggerOptions;

/** The options merged from every `configure()` call, as the app passed them; `run()` checks them. */
export type ConfiguredOptions = Partial<Record<OptionName, unknown>>;

const OPTION_NAMES: readonly OptionName[] = [
  "enabled",
  "url",
  "token",
  "service",
  "labels",
  "redact",
  "logger",
  "logLevel",
  "hubConnector",
  "connector",
];

// The fields only the default connector uses, so a custom connector makes them meaningless
const HUB_OPTION_NAMES: readonly OptionName[] = ["url", "token", "service", "labels", "hubConnector"];

const CONNECTOR_METHODS = ["connect", "send", "onMessage", "onStatus", "close"];

/**
 * Returns the fields of one `configure()` call that are set, read once so a getter runs only here; `undefined` when
 * `options` is not an object. A field whose getter throws is skipped with a warning.
 */
export const readConfigureOptions = (options: unknown, warn: Warn): ConfiguredOptions | undefined => {
  if (options === undefined) {
    return {};
  }

  if (!isRecord(options)) {
    warn("options must be an object; nothing changed");
    return undefined;
  }

  const fields: ConfiguredOptions = {};
  for (const name of OPTION_NAMES) {
    const value = readField(options, name, warn);
    if (value !== undefined) {
      fields[name] = value;
    }
  }

  return fields;
};

/** Resolves `enabled` as the option, then `PROBEX_ENABLED`, then `true` (ADR 0003); an invalid one warns. */
export const resolveEnabled = (option: unknown, env: Environment, warn: Warn): boolean => {
  if (option !== undefined) {
    if (typeof option === "boolean") {
      return option;
    }

    warn("enabled must be true or false; using true");
    return true;
  }

  // Exact values only, like PROBEX_LOG_LEVEL: `False` or `0` warn instead of guessing
  const value = readEnv(env, "PROBEX_ENABLED");
  if (value === undefined || value === "true") {
    return true;
  }

  if (value !== "false") {
    warn("PROBEX_ENABLED must be true or false; using true");
    return true;
  }

  return false;
};

/** Tells whether `value` has every method of a `Connector`; apps may be plain JavaScript, so it is checked. */
export const isConnector = (value: unknown): value is Connector => {
  if (!isRecord(value)) {
    return false;
  }

  try {
    return CONNECTOR_METHODS.every((name) => typeof Reflect.get(value, name) === "function");
  } catch {
    // A getter or Proxy trap that throws: not a connector the debugger can call
    return false;
  }
};

/** Returns the names of the default connector's options that are set, which a custom connector ignores. */
export const findHubOptions = (options: ConfiguredOptions): OptionName[] =>
  HUB_OPTION_NAMES.filter((name) => options[name] !== undefined);
