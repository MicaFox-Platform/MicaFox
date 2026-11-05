import { createRedactionRules, normalizeName, type RedactionRules } from "./redaction-rules.js";
import { isRecord, readEnv, type Warn } from "../../connector/index.js";
import type { Environment } from "../../logger/index.js";

/** The most names `redact` and `PROBEX_REDACT` add together, so `run()` and every match in a pause stay cheap. */
const MAX_ADDED_NAMES = 100;

const NOT_AN_ARRAY = "redact must be an array of names; it is ignored";

// Stands for an entry whose getter threw, which was already reported
const UNREADABLE = Symbol("unreadable");

// The length of the app's array, read once; undefined for anything else, a revoked Proxy included
const readLength = (option: object): number | undefined => {
  try {
    return Array.isArray(option) ? option.length : undefined;
  } catch {
    return undefined;
  }
};

// Copied entry by entry at run(), so later changes to the app's array have no effect (ADR 0003), a getter that
// throws costs one warning, and a huge or sparse array costs at most MAX_ADDED_NAMES + 1 reads
const copyOptionEntries = (option: object, length: number, warn: Warn): unknown[] =>
  Array.from({ length: Math.min(length, MAX_ADDED_NAMES + 1) }, (_unused, index): unknown => {
    try {
      return Reflect.get(option, index);
    } catch {
      warn("redact has an entry that could not be read; it is skipped");
      return UNREADABLE;
    }
  }).filter((entry) => entry !== UNREADABLE);

// Names that cannot be rules are skipped with a warning, so a typo never turns redaction off for the other names.
// Warnings never quote an entry, which may be a name the app keeps private
const keepUsable = (names: readonly unknown[], source: string, warn: Warn): string[] =>
  names.flatMap((name) => {
    if (typeof name === "string" && normalizeName(name.trim()) !== "") {
      return [name.trim()];
    }

    warn(`${source} has an entry that is not a usable name; it is skipped`);
    return [];
  });

const readOptionNames = (option: unknown, warn: Warn): string[] => {
  if (option === undefined) {
    return [];
  }

  const length = isRecord(option) ? readLength(option) : undefined;
  if (!isRecord(option) || length === undefined) {
    warn(NOT_AN_ARRAY);
    return [];
  }

  return keepUsable(copyOptionEntries(option, length, warn), "redact", warn);
};

const readEnvNames = (env: Environment, warn: Warn): string[] => {
  const value = readEnv(env, "PROBEX_REDACT");
  return value === undefined ? [] : keepUsable(value.split(",", MAX_ADDED_NAMES + 1), "PROBEX_REDACT", warn);
};

/**
 * Resolves the rules of one `run()`: the built-in names, plus the `redact` option and `PROBEX_REDACT` (names separated
 * by commas, trimmed), which both apply, at most 100 names together. An entry empty after normalizing, not a string
 * or not readable is skipped with a warning. Never throws.
 */
export const resolveRedaction = (option: unknown, env: Environment, warn: Warn): RedactionRules => {
  const added = [...readOptionNames(option, warn), ...readEnvNames(env, warn)];
  if (added.length > MAX_ADDED_NAMES) {
    warn(`redact and PROBEX_REDACT add at most ${String(MAX_ADDED_NAMES)} names; the rest are ignored`);
  }

  return createRedactionRules(added.slice(0, MAX_ADDED_NAMES));
};
