/** The lowest level the SDK writes; `silent` writes nothing. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** A level a line is written at: every level but `silent`. */
export type LineLevel = Exclude<LogLevel, "silent">;

const RANKS: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

/** The level used when neither the option nor `MICAFOX_LOG_LEVEL` gives a valid one. */
export const DEFAULT_LOG_LEVEL: LogLevel = "warn";

/** The methods every `Logger` has, one per line level. */
export const LINE_LEVELS: readonly LineLevel[] = ["debug", "info", "warn", "error"];

/** Returns the rank of `level`: a line is written when its rank is at least the threshold's. */
export const rankOf = (level: LogLevel): number => RANKS[level];

/** Tells whether `value` is exactly one of the level names; case and whitespace count. */
export const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && Object.hasOwn(RANKS, value);
