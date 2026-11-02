import { resolveLabels, type Labels } from "./labels.js";
import { isRecord, readEnv, readOption, withPrefix, type Warn } from "./read-field.js";
import type { Environment, Logger, LogLevel } from "../../logger/index.js";

/** `HubConnectorOptions` after resolution: every number has a valid value; the strings have no default. */
export interface ResolvedConnectorOptions {
  url: string | undefined;
  token: string | undefined;
  service: string | undefined;
  labels: Labels;
  buffer: { maxMessages: number; maxBytes: number };
  batch: { maxMessages: number; maxBytes: number; flushIntervalMs: number };
  rateLimit: { bytesPerSecond: number };
  reconnect: { minDelayMs: number; maxDelayMs: number };
  closeTimeoutMs: number;
}

type StringOption = "url" | "token" | "service";

// Only values that differ per deployment have an environment variable (ADR 0003)
const STRING_OPTION_ENV: Readonly<Record<StringOption, string>> = {
  url: "PROBEX_HUB_URL",
  token: "PROBEX_TOKEN",
  service: "PROBEX_SERVICE",
};

// The defaults of docs/api/sdk/connector.md#hubconnector
const DEFAULT_BUFFER_MAX_MESSAGES = 1000;
const DEFAULT_BUFFER_MAX_BYTES = 1_048_576;
const DEFAULT_BATCH_MAX_MESSAGES = 100;
const DEFAULT_BATCH_MAX_BYTES = 65_536;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_BYTES_PER_SECOND = 1_048_576;
const DEFAULT_MIN_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

interface Source {
  env: Environment;
  warn: Warn;
}

type ReadPositiveInteger = (name: string, fallback: number) => number;

// A passed value that is invalid skips the environment variable, as an invalid `logLevel` does in the logger
const resolveStringOption = (
  options: object | undefined,
  name: StringOption,
  { env, warn }: Source,
): string | undefined => {
  const value = readOption(options, name, warn);
  if (value === undefined) {
    return readEnv(env, STRING_OPTION_ENV[name]);
  }

  if (typeof value === "string") {
    return value;
  }

  // The value itself is never logged: it may be the token
  warn(`${name} must be a string; it is ignored`);
  return undefined;
};

// An option group such as `buffer`: anything but an object logs a warning, and its defaults are used
const readGroup = (options: object | undefined, name: string, warn: Warn): object | undefined => {
  const value = readOption(options, name, warn);
  if (value === undefined || isRecord(value)) {
    return value;
  }

  warn(`${name} must be an object; using its defaults`);
  return undefined;
};

// Reads the number fields of `fields`; anything but a finite integer of at least 1 logs a warning, and the default
// is used
const createPositiveIntegerReader =
  (fields: object | undefined, warn: Warn): ReadPositiveInteger =>
  (name, fallback) => {
    const value = readOption(fields, name, warn);
    if (value === undefined) {
      return fallback;
    }

    if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
      return value;
    }

    warn(`${name} must be an integer of at least 1; using ${String(fallback)}`);
    return fallback;
  };

const createGroupReader = (options: object | undefined, name: string, warn: Warn): ReadPositiveInteger =>
  createPositiveIntegerReader(readGroup(options, name, warn), withPrefix(name, warn));

const resolveReconnect = (options: object | undefined, warn: Warn): ResolvedConnectorOptions["reconnect"] => {
  const reconnect = createGroupReader(options, "reconnect", warn);
  const minDelayMs = reconnect("minDelayMs", DEFAULT_MIN_DELAY_MS);
  const maxDelayMs = reconnect("maxDelayMs", DEFAULT_MAX_DELAY_MS);
  if (minDelayMs <= maxDelayMs) {
    return { minDelayMs, maxDelayMs };
  }

  warn(
    "reconnect.minDelayMs must not exceed reconnect.maxDelayMs; " +
      `using ${String(DEFAULT_MIN_DELAY_MS)} and ${String(DEFAULT_MAX_DELAY_MS)}`,
  );
  return { minDelayMs: DEFAULT_MIN_DELAY_MS, maxDelayMs: DEFAULT_MAX_DELAY_MS };
};

/**
 * Resolves each option once: the passed value, then its environment variable, then the default (ADR 0003). An
 * invalid value logs a warning through `warn` and its default is used; nothing here throws.
 */
export const resolveOptions = (options: object | undefined, source: Source): ResolvedConnectorOptions => {
  const { env, warn } = source;
  const buffer = createGroupReader(options, "buffer", warn);
  const batch = createGroupReader(options, "batch", warn);
  const rateLimit = createGroupReader(options, "rateLimit", warn);
  return {
    url: resolveStringOption(options, "url", source),
    token: resolveStringOption(options, "token", source),
    service: resolveStringOption(options, "service", source),
    labels: resolveLabels(readOption(options, "labels", warn), env, warn),
    buffer: {
      maxMessages: buffer("maxMessages", DEFAULT_BUFFER_MAX_MESSAGES),
      maxBytes: buffer("maxBytes", DEFAULT_BUFFER_MAX_BYTES),
    },
    batch: {
      maxMessages: batch("maxMessages", DEFAULT_BATCH_MAX_MESSAGES),
      maxBytes: batch("maxBytes", DEFAULT_BATCH_MAX_BYTES),
      flushIntervalMs: batch("flushIntervalMs", DEFAULT_FLUSH_INTERVAL_MS),
    },
    rateLimit: { bytesPerSecond: rateLimit("bytesPerSecond", DEFAULT_BYTES_PER_SECOND) },
    reconnect: resolveReconnect(options, warn),
    closeTimeoutMs: createPositiveIntegerReader(options, warn)("closeTimeoutMs", DEFAULT_CLOSE_TIMEOUT_MS),
  };
};

/** The options of `HubConnector`; every field is optional (docs/api/sdk/connector.md#hubconnectoroptions). */
export interface HubConnectorOptions {
  url?: string;
  token?: string;
  service?: string;
  labels?: Record<string, string>;
  logger?: Logger;
  logLevel?: LogLevel;
  buffer?: { maxMessages?: number; maxBytes?: number };
  batch?: { maxMessages?: number; maxBytes?: number; flushIntervalMs?: number };
  rateLimit?: { bytesPerSecond?: number };
  reconnect?: { minDelayMs?: number; maxDelayMs?: number };
  closeTimeoutMs?: number;
}
