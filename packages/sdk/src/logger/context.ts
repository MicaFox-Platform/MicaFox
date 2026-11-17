/** The fields of one log line, passed to every `Logger` method as plain, serializable values. */
export interface LogContext {
  component: string;
  breakpointId?: string;
  error?: { name: string; message: string; code?: string; stack?: string };
  count?: number;
}

/** What a call site knows about a line besides its message; `error` is anything that was thrown. */
export interface LineFields {
  component: string;
  /** Names the problem for collapsing repeats; a line without it is never collapsed. Not part of the context. */
  key?: string;
  breakpointId?: string;
  error?: unknown;
}

type ErrorContext = NonNullable<LogContext["error"]>;

const UNPRINTABLE = "[value cannot be converted to a string]";

// Anything thrown may be hostile: a Proxy, a getter that throws, a `toString` that throws.
// Every read below is guarded so that describing an error never throws into the caller.

const toText = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return UNPRINTABLE;
  }
};

const readString = (read: () => unknown): string | undefined => {
  try {
    const value = read();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

const readCode = (error: Error): string | undefined => {
  try {
    const code: unknown = Reflect.get(error, "code");
    return code == null ? undefined : toText(code);
  } catch {
    return undefined;
  }
};

const isError = (value: unknown): value is Error => {
  try {
    return value instanceof Error;
  } catch {
    // A Proxy whose getPrototypeOf trap throws
    return false;
  }
};

/** Returns the `code` of a thrown `Error` as a string, without throwing; `undefined` when it has none. */
export const readErrorCode = (value: unknown): string | undefined => (isError(value) ? readCode(value) : undefined);

const toErrorContext = (value: unknown): ErrorContext => {
  if (!isError(value)) {
    return { name: "NonError", message: toText(value) };
  }

  const code = readCode(value);
  const stack = readString(() => value.stack);
  return {
    name: readString(() => value.name) ?? "Error",
    message: readString(() => value.message) ?? "",
    ...(code === undefined ? {} : { code }),
    ...(stack === undefined ? {} : { stack }),
  };
};

/** Builds the context of a line; an error becomes plain strings, because JSON output turns an `Error` into `{}`. */
export const toLogContext = ({ component, breakpointId, error }: LineFields): LogContext => ({
  component,
  ...(breakpointId === undefined ? {} : { breakpointId }),
  ...(error === undefined ? {} : { error: toErrorContext(error) }),
});
