import type { LogContext } from "./context.js";
import { LINE_LEVELS, type LineLevel } from "./level.js";

/** Where the SDK writes its own problems: `console`, pino, winston or any object with these four methods. */
export interface Logger {
  debug(message: string, context: LogContext): void;
  info(message: string, context: LogContext): void;
  warn(message: string, context: LogContext): void;
  error(message: string, context: LogContext): void;
}

/** Tells whether `value` has the four `Logger` methods; callable loggers that carry them count too. */
export const isLogger = (value: unknown): value is Logger => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }

  try {
    return LINE_LEVELS.every((level) => typeof Reflect.get(value, level) === "function");
  } catch {
    // A getter or Proxy trap that throws: the logger cannot be called safely
    return false;
  }
};

const ignore = (): void => {
  // A rejection from the app's logger has nowhere safe to go: writing it to the same logger could fail again
};

const catchRejection = (result: unknown): void => {
  if (result === null || (typeof result !== "object" && typeof result !== "function")) {
    return;
  }

  // Only thenables get a handler, so a logger returning `this` (winston) costs no promise
  const then: unknown = Reflect.get(result, "then");
  if (typeof then === "function") {
    Reflect.apply(then, result, [undefined, ignore]);
  }
};

/** Calls `target[level]` with `this` bound to it; whatever it throws or rejects with is ignored. */
export const callLogger = (target: Logger, level: LineLevel, args: readonly unknown[]): void => {
  try {
    // Read at call time: the app may replace a method after handing the logger over
    const method: unknown = Reflect.get(target, level);
    if (typeof method !== "function") {
      return;
    }

    const result: unknown = Reflect.apply(method, target, args);
    catchRejection(result);
  } catch {
    // The app's logger failed; reporting that through the same logger could fail again or loop
  }
};
