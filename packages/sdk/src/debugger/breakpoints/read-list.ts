import type { CaptureLimits } from "@micafox/protocol";

import type { ListedEntry } from "./entry.js";
import { isRecord } from "../../connector/index.js";
import { toSegments } from "../location/index.js";

/** Entries beyond these are ignored, then get `error`; the protocol API states both limits. */
const MAX_READ_ENTRIES = 200;
const MAX_ENTRIES = 100;
const MAX_ID_LENGTH = 256;
const MAX_FILE_LENGTH = 1024;
const LIMIT_NAMES = ["maxDepth", "maxItems", "maxStringLength"] as const;

/** What one `breakpoints` message holds: an entry for each that gets a status, in list order. */
export interface BreakpointList {
  entries: ListedEntry[];
  warnings: string[];
}

const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

// The caps of the limits are applied when a snapshot is captured; here only their shape is checked
const readLimits = (limits: unknown): CaptureLimits | string | undefined => {
  if (limits === undefined) {
    return undefined;
  }

  if (!isRecord(limits)) {
    return "limits must be an object";
  }

  const read: CaptureLimits = {};
  for (const name of LIMIT_NAMES) {
    const value: unknown = Reflect.get(limits, name);
    if (value === undefined) {
      continue;
    }

    if (!isPositiveInteger(value)) {
      return `limits.${name} must be a positive integer`;
    }

    read[name] = value;
  }

  return read;
};

const readEntry = (id: string, item: object): ListedEntry => {
  const file: unknown = Reflect.get(item, "file");
  const line: unknown = Reflect.get(item, "line");
  if (id.length > MAX_ID_LENGTH) {
    return { kind: "invalid", id, message: `id must be at most ${String(MAX_ID_LENGTH)} characters` };
  }

  if (typeof file !== "string" || file === "" || file.length > MAX_FILE_LENGTH) {
    return {
      kind: "invalid",
      id,
      message: `file must be a non-empty string of at most ${String(MAX_FILE_LENGTH)} characters`,
    };
  }

  // Such as "/" or "./": no loaded file could ever match it
  if (toSegments(file).length === 0) {
    return { kind: "invalid", id, message: "file must name a file" };
  }

  if (!isPositiveInteger(line)) {
    return { kind: "invalid", id, message: "line must be a positive integer" };
  }

  const limits = readLimits(Reflect.get(item, "limits"));
  if (typeof limits === "string") {
    return { kind: "invalid", id, message: limits };
  }

  return limits === undefined ? { kind: "valid", id, file, line } : { kind: "valid", id, file, line, limits };
};

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

interface ReadItems {
  entries: ListedEntry[];
  withoutId: number;
  repeated: number;
}

const readItems = (items: readonly unknown[]): ReadItems => {
  const read: ReadItems = { entries: [], withoutId: 0, repeated: 0 };
  const seenIds = new Set<string>();

  for (const item of items) {
    const id: unknown = isRecord(item) ? Reflect.get(item, "id") : undefined;
    if (!isRecord(item) || typeof id !== "string") {
      read.withoutId += 1;
    } else if (seenIds.has(id)) {
      read.repeated += 1;
    } else {
      seenIds.add(id);
      read.entries.push(
        read.entries.length >= MAX_ENTRIES
          ? { kind: "invalid", id, message: `at most ${String(MAX_ENTRIES)} breakpoints are set` }
          : readEntry(id, item),
      );
    }
  }

  return read;
};

const describeIgnored = (total: number, { withoutId, repeated }: ReadItems): string[] => {
  const warnings: string[] = [];
  if (total > MAX_READ_ENTRIES) {
    warnings.push(
      `only the first ${String(MAX_READ_ENTRIES)} breakpoints are read; the other ${String(total - MAX_READ_ENTRIES)} are ignored`,
    );
  }

  if (withoutId > 0) {
    warnings.push(`${plural(withoutId, "breakpoint")} without a string id ignored`);
  }

  if (repeated > 0) {
    warnings.push(`${plural(repeated, "repeated id")} ignored; the first entry of an id is used`);
  }

  return warnings;
};

/**
 * Reads the `breakpoints` field of a message from the hub, which is not trusted. Returns `undefined` when it is not
 * an array. Time and memory are bounded by the 200 entries read.
 */
export const readBreakpointList = (message: unknown): BreakpointList | undefined => {
  const list: unknown = isRecord(message) ? Reflect.get(message, "breakpoints") : undefined;
  if (!Array.isArray(list)) {
    return undefined;
  }

  const read = readItems((list as unknown[]).slice(0, MAX_READ_ENTRIES));
  return { entries: read.entries, warnings: describeIgnored(list.length, read) };
};
