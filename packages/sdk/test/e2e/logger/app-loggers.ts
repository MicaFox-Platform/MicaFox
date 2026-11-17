// The app loggers the fixture server can hand to the SDK, picked by name from `E2E_LOGGER`

import type { LogContext, Logger } from "../../../src/logger/index.js";

/** One line as the recording logger writes it to stdout, one JSON object per line. */
export interface RecordedLine {
  level: string;
  message: string;
  context: LogContext;
}

const record =
  (level: string) =>
  (message: string, context: LogContext): void => {
    process.stdout.write(`${JSON.stringify({ level, message, context } satisfies RecordedLine)}\n`);
  };

const recording: Logger = {
  debug: record("debug"),
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
};

const fail = (): never => {
  throw new Error("app logger failed");
};

const throwing: Logger = { debug: fail, info: fail, warn: fail, error: fail };

const reject = (): Promise<never> => Promise.reject(new Error("app logger rejected"));

// Typed loosely on purpose: an app may pass a logger whose methods return promises
const rejecting = { debug: reject, info: reject, warn: reject, error: reject };

// Has no `debug`, `warn` or `error`, so the SDK must refuse it
const invalid = { info: record("info") };

const APP_LOGGERS = { recording, throwing, rejecting, invalid } satisfies Readonly<Record<string, unknown>>;

/** The name of an app logger, as `E2E_LOGGER` gives it. */
export type AppLoggerName = keyof typeof APP_LOGGERS;

/** Returns the app logger named `name`, or `undefined` (the SDK's default console) for no name or an unknown one. */
export const findAppLogger = (name: string | undefined): unknown =>
  name === undefined ? undefined : Reflect.get(APP_LOGGERS, name);
