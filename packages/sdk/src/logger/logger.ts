import { callLogger, isLogger, type Logger } from "./app-logger.js";
import { RepeatCollapser, type RepeatSummary } from "./collapse.js";
import type { LineFields, LogContext } from "./context.js";
import { DEFAULT_LOG_LEVEL, isLogLevel, rankOf, type LineLevel, type LogLevel } from "./level.js";
import type { TakenLines } from "./line-queue.js";
import { PauseHold } from "./pause-hold.js";

const LEVEL_NAMES = "debug, info, warn, error or silent";
const INVALID_LEVEL_WARNINGS: Readonly<Record<LevelSource, string>> = {
  option: `logLevel must be one of ${LEVEL_NAMES}; using ${DEFAULT_LOG_LEVEL}`,
  env: `MICAFOX_LOG_LEVEL must be one of ${LEVEL_NAMES}; using ${DEFAULT_LOG_LEVEL}`,
};
const INVALID_LOGGER = "logger must be an object with debug, info, warn and error methods; using console";

/** Environment variables, as in `process.env`. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The `logger` and `logLevel` options as the app passed them; unchecked, since apps may be plain JavaScript. */
export interface LoggerOptions {
  logger?: unknown;
  logLevel?: unknown;
}

/** What `createLogger()` needs from outside. */
export interface LoggerDependencies {
  /** The component that owns the logger; it signs the warning about `MICAFOX_LOG_LEVEL` before any `set()`. */
  component: string;
  env?: Environment;
  console?: Logger;
  /** A monotonic clock in milliseconds, for collapse windows. */
  now?: () => number;
}

type LevelSource = "option" | "env";

interface ResolvedLevel {
  level: LogLevel;
  /** Where an invalid value came from; absent when the value was valid or unset. */
  invalidSource?: LevelSource;
}

// Option, then MICAFOX_LOG_LEVEL, then the default (ADR 0003, ADR 0015); an empty variable counts as unset
const resolveLevel = (option: unknown, env: Environment): ResolvedLevel => {
  if (option !== undefined) {
    return isLogLevel(option) ? { level: option } : { level: DEFAULT_LOG_LEVEL, invalidSource: "option" };
  }

  const value = env.MICAFOX_LOG_LEVEL;
  if (value === undefined || value === "") {
    return { level: DEFAULT_LOG_LEVEL };
  }

  return isLogLevel(value) ? { level: value } : { level: DEFAULT_LOG_LEVEL, invalidSource: "env" };
};

/** The SDK's own logger: filters by level, formats each line and calls the app's logger without ever throwing. */
export class SdkLogger {
  private threshold: number | undefined;
  private target: Logger;
  private passesContext = false;
  private hasReportedInvalidEnv = false;
  private readonly owner: string;
  private readonly env: Environment;
  private readonly defaultConsole: Logger;
  private readonly collapser: RepeatCollapser;
  private readonly pauseHold: PauseHold;

  constructor({ component, env, console: defaultConsole, now }: Required<LoggerDependencies>) {
    this.owner = component;
    this.env = env;
    this.defaultConsole = defaultConsole;
    this.target = defaultConsole;
    this.collapser = new RepeatCollapser((summary) => {
      this.logSummary(summary);
    }, now);
    this.pauseHold = new PauseHold((taken) => {
      this.writeTaken(taken);
    });
  }

  /** Resolves `logLevel` and `logger`; a warning about an invalid one carries `component`. */
  set({ logger, logLevel }: LoggerOptions, component: string): void {
    const resolved = resolveLevel(logLevel, this.env);
    const appLogger = isLogger(logger) ? logger : undefined;
    this.threshold = rankOf(resolved.level);
    this.target = appLogger ?? this.defaultConsole;
    // A passed logger gets the context, even when it is `console` itself
    this.passesContext = appLogger !== undefined;

    this.reportInvalidLevel(resolved, component);
    if (logger !== undefined && appLogger === undefined) {
      this.log("warn", INVALID_LOGGER, { component });
    }
  }

  /** Tells whether a line at `level` would be written; ask it before building an expensive message. */
  enabled(level: LineLevel): boolean {
    return rankOf(level) >= this.currentThreshold();
  }

  /** Writes `[micafox] <component>: <message>` and its context, unless `level` is below the threshold. */
  log(level: LineLevel, message: string, fields: LineFields): void {
    // Return before `fields` is read: a line below the level costs one comparison
    if (rankOf(level) < this.currentThreshold()) {
      return;
    }

    const context = this.collapser.admit(level, message, fields);
    if (context !== undefined) {
      this.write(level, message, context);
    }
  }

  /**
   * Makes every logger in the process queue its lines until `release()`, so the app's logger never runs while the
   * thread is paused. A second call does nothing.
   */
  hold(): void {
    this.pauseHold.hold();
  }

  /** Ends the hold; the queued lines are written in a `setImmediate`, after the thread resumes. */
  release(): void {
    this.pauseHold.release();
  }

  /**
   * Writes the queued lines and the summaries of open collapse windows, and stops the timer; lines written later are
   * still logged. While held, the queue stays for `release()`.
   */
  flush(): void {
    this.pauseHold.flush();
    this.collapser.flush();
  }

  // The callers build `context` with toLogContext(), which never throws, so neither does this
  private write(level: LineLevel, message: string, context: LogContext): void {
    if (this.pauseHold.shouldQueue()) {
      this.pauseHold.enqueue({ level, message, context });
      return;
    }

    this.emit(level, message, context);
  }

  private writeTaken({ lines, dropped }: TakenLines): void {
    for (const { level, message, context } of lines) {
      this.emit(level, message, context);
    }

    if (dropped !== undefined && this.enabled("warn")) {
      this.emit("warn", `log lines dropped while the thread was paused: ${String(dropped.count)}`, {
        component: dropped.component,
      });
    }
  }

  private emit(level: LineLevel, message: string, context: LogContext): void {
    const text = `[micafox] ${context.component}: ${message}`;
    if (this.passesContext) {
      // Outside text is passed as it is: a `%s` in it only moves the context into the message (ADR 0014)
      callLogger(this.target, level, [text, context]);
    } else {
      // The default console prints the message only, and with a single argument it formats nothing
      callLogger(this.target, level, [text]);
    }
  }

  private logSummary({ level, message, context, repeats, elapsedSeconds }: RepeatSummary): void {
    // set() may have raised the level since the first line was written
    if (this.enabled(level)) {
      this.write(level, `${message} (repeated ${String(repeats)} times in ${String(elapsedSeconds)} s)`, {
        ...context,
        count: repeats,
      });
    }
  }

  private currentThreshold(): number {
    if (this.threshold !== undefined) {
      return this.threshold;
    }

    // Read when the first line is written, not at load, so the app can still set the variable after importing
    const resolved = resolveLevel(undefined, this.env);
    this.threshold = rankOf(resolved.level);
    this.reportInvalidLevel(resolved, this.owner);
    return this.threshold;
  }

  // The environment does not change between set() calls, so its warning is written once per logger
  private reportInvalidLevel({ invalidSource }: ResolvedLevel, component: string): void {
    if (invalidSource === undefined || (invalidSource === "env" && this.hasReportedInvalidEnv)) {
      return;
    }

    this.hasReportedInvalidEnv ||= invalidSource === "env";
    this.log("warn", INVALID_LEVEL_WARNINGS[invalidSource], { component });
  }
}

/** Creates the SDK's logger; it writes to `console` at `MICAFOX_LOG_LEVEL`, or `warn`, until `set()` is called. */
export const createLogger = ({
  component,
  env = process.env,
  console: defaultConsole = console,
  now = () => performance.now(),
}: LoggerDependencies): SdkLogger => new SdkLogger({ component, env, console: defaultConsole, now });
