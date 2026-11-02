import type { Environment } from "../../logger/index.js";

/** Writes a warning about an option that was replaced by its default or skipped. */
export type Warn = (message: string) => void;

/** Tells whether `value` is an object whose fields can be read; `typeof` never throws, even on a revoked Proxy. */
export const isRecord = (value: unknown): value is object => typeof value === "object" && value !== null;

/** Returns a `Warn` that names the field by its full path, such as `buffer.maxBytes`. */
export const withPrefix =
  (prefix: string, warn: Warn): Warn =>
  (message) => {
    warn(`${prefix}.${message}`);
  };

/**
 * Reads `object[name]`. Options come from the app, possibly plain JavaScript, so a getter or Proxy trap that throws
 * logs a warning and reads as unset.
 */
export const readField = (object: object | undefined, name: PropertyKey, warn: Warn): unknown => {
  if (object === undefined) {
    return undefined;
  }

  try {
    return Reflect.get(object, name);
  } catch {
    warn(`${String(name)} could not be read; it is ignored`);
    return undefined;
  }
};

/** Reads an option like `readField`; an empty string counts as unset (ADR 0003). */
export const readOption = (object: object | undefined, name: PropertyKey, warn: Warn): unknown => {
  const value = readField(object, name, warn);
  return value === "" ? undefined : value;
};

/** Returns the environment variable `name`; an empty value counts as unset. */
export const readEnv = (env: Environment, name: string): string | undefined => {
  const value = env[name];
  return value === "" ? undefined : value;
};
