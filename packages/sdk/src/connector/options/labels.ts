import { isRecord, readEnv, readField, withPrefix, type Warn } from "./read-field.js";
import type { Environment } from "../../logger/index.js";

/** Labels the hub can target breakpoints by. */
export type Labels = Readonly<Record<string, string>>;

const NO_LABELS = "labels must be an object of strings; using no labels";

// PROBEX_LABELS: `key=value` pairs separated by commas, each trimmed and split at the first `=`.
// Warnings name an entry by position, never by its text, which may hold a value the app keeps private.
const parseLabels = (text: string, warn: Warn): Labels => {
  // A Map keeps the later value of a repeated key; Object.fromEntries makes even `__proto__` an own property
  const labels = new Map<string, string>();
  for (const [index, raw] of text.split(",").entries()) {
    const entry = raw.trim();
    // A trailing or doubled comma is not an entry
    if (entry === "") {
      continue;
    }

    const separator = entry.indexOf("=");
    const key = separator === -1 ? "" : entry.slice(0, separator).trim();
    if (key === "") {
      const problem = separator === -1 ? 'has no "="' : "has an empty key";
      warn(`PROBEX_LABELS entry ${String(index + 1)} ${problem}; skipped`);
      continue;
    }

    labels.set(key, entry.slice(separator + 1).trim());
  }

  return Object.fromEntries(labels);
};

const listKeys = (value: object): string[] | undefined => {
  try {
    return Array.isArray(value) ? undefined : Object.keys(value);
  } catch {
    // A Proxy whose ownKeys trap throws, or a revoked one
    return undefined;
  }
};

// Copied, so that later changes to the app's object have no effect (ADR 0003)
const copyLabels = (value: unknown, warn: Warn): Labels => {
  const keys = isRecord(value) ? listKeys(value) : undefined;
  if (!isRecord(value) || keys === undefined) {
    warn(NO_LABELS);
    return {};
  }

  const labels = new Map<string, string>();
  for (const key of keys) {
    const label = readField(value, key, withPrefix("labels", warn));
    // Unset, or a getter that threw and was already reported
    if (label === undefined) {
      continue;
    }

    if (key === "") {
      warn("labels has an entry with an empty key; skipped");
      continue;
    }

    if (typeof label !== "string") {
      warn(`labels.${key} must be a string; skipped`);
      continue;
    }

    labels.set(key, label);
  }

  return Object.fromEntries(labels);
};

/** Resolves `labels`: a passed value replaces `PROBEX_LABELS`; no labels by default. */
export const resolveLabels = (passed: unknown, env: Environment, warn: Warn): Labels => {
  if (passed !== undefined) {
    return copyLabels(passed, warn);
  }

  const text = readEnv(env, "PROBEX_LABELS");
  return text === undefined ? {} : parseLabels(text, warn);
};
