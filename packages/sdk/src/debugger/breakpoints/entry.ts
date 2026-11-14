import { PROTOCOL_VERSION, type BreakpointStatus, type CaptureLimits } from "@micafox/protocol";

import type { ScriptPosition } from "../location/index.js";

/** An entry of a `breakpoints` message whose fields are valid. */
export interface ValidEntry {
  kind: "valid";
  id: string;
  file: string;
  /** 1-based, as the hub sends it. */
  line: number;
  /** The milliseconds the entry had left when its list arrived, at most 24 h. */
  expiresInMs: number;
  limits?: CaptureLimits;
}

/** An entry that gets status `error` and is never set in V8. */
export interface InvalidEntry {
  kind: "invalid";
  id: string;
  message: string;
}

export type ListedEntry = ValidEntry | InvalidEntry;

/**
 * Where an entry is set: `place` names its V8 breakpoint, set at `position` of the script at `url`, and `mapUrl` the
 * URL of the script whose map placed it, which holds that map.
 */
export interface Placed {
  place: string;
  url: string;
  position: ScriptPosition;
  mapUrl?: string;
}

/** A set entry that captures. */
export interface ActiveOutcome extends Placed {
  status: "active";
}

/** A set entry off until its rate limit refills; it is set again where it was. */
export interface RateLimitedOutcome extends Placed {
  status: "rateLimited";
}

/** An entry whose time ran out: it holds no V8 breakpoint and stays so while it is listed. */
export interface ExpiredOutcome {
  status: "expired";
}

/**
 * What became of an entry. A retryable error came from a map that could not be used and is resolved again like a
 * pending entry.
 */
export type Outcome =
  | { status: "pending" }
  | ActiveOutcome
  | RateLimitedOutcome
  | ExpiredOutcome
  | { status: "error"; message: string; isRetryable?: boolean };

/** An entry of the latest list and what became of it. */
export interface Applied {
  entry: ListedEntry;
  /** The segments of the entry's `file`; empty for an invalid entry. */
  segments: string[];
  outcome: Outcome;
}

/** Whether the entry holds its place and the map that placed it. */
export const isPlaced = (outcome: Outcome): outcome is ActiveOutcome | RateLimitedOutcome =>
  outcome.status === "active" || outcome.status === "rateLimited";

/** Whether a later script may still change the outcome: it is pending, or an error that is retried. */
export const isUnresolved = (outcome: Outcome): boolean =>
  outcome.status === "pending" || (outcome.status === "error" && outcome.isRetryable === true);

/** Whether two outcomes send the same status. */
export const isSameStatus = (first: Outcome, second: Outcome): boolean =>
  first.status === second.status &&
  (first.status !== "error" || (second.status === "error" && first.message === second.message));

/**
 * How many of `outcomes` have each status, such as `1 active, 2 pending, 0 error`; rate limited ones are added only
 * when there are any, which happens while every breakpoint is off, and expired ones likewise.
 */
export const summarizeOutcomes = (outcomes: readonly Outcome[]): string => {
  const counts = { active: 0, pending: 0, rateLimited: 0, expired: 0, error: 0 };
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
  }

  const summary = `${String(counts.active)} active, ${String(counts.pending)} pending, ${String(counts.error)} error`;
  const withRateLimited = counts.rateLimited === 0 ? summary : `${summary}, ${String(counts.rateLimited)} rate limited`;
  return counts.expired === 0 ? withRateLimited : `${withRateLimited}, ${String(counts.expired)} expired`;
};

/** The `breakpointStatus` message of an entry's outcome. */
export const toStatus = (breakpointId: string, outcome: Outcome): BreakpointStatus => {
  const base = { version: PROTOCOL_VERSION, module: "debugger", type: "breakpointStatus", breakpointId } as const;
  return outcome.status === "error"
    ? { ...base, status: "error", message: outcome.message }
    : { ...base, status: outcome.status };
};

const isSameLimits = (first: CaptureLimits | undefined, second: CaptureLimits | undefined): boolean =>
  first?.maxDepth === second?.maxDepth &&
  first?.maxItems === second?.maxItems &&
  first?.maxStringLength === second?.maxStringLength;

/** Tells whether `next` leaves the breakpoint of `current` as it is: the same `file`, `line` and `limits`; the time left is not compared. */
export const isSameEntry = (current: ListedEntry, next: ListedEntry): boolean => {
  if (current.kind === "invalid" || next.kind === "invalid") {
    return current.kind === "invalid" && next.kind === "invalid" && current.message === next.message;
  }

  return current.file === next.file && current.line === next.line && isSameLimits(current.limits, next.limits);
};

/** An applied entry that the latest list removed or changed, and so loses its V8 breakpoint. */
export interface Dropped {
  id: string;
  current: Applied;
  /** Whether the list no longer has the `id`. */
  isRemoved: boolean;
}

/**
 * The applied entries that a list removes or changes. An expired entry is final while it is listed, whatever its
 * fields now are.
 */
export const diffList = (applied: ReadonlyMap<string, Applied>, entries: readonly ListedEntry[]): Dropped[] => {
  const next = new Map(entries.map((entry) => [entry.id, entry]));
  return [...applied].flatMap(([id, current]): Dropped[] => {
    const replacement = next.get(id);
    if (replacement === undefined) {
      return [{ id, current, isRemoved: true }];
    }

    // A changed entry keeps its rate limit, so sending the list again does not reset it
    const isChanged = current.outcome.status !== "expired" && !isSameEntry(current.entry, replacement);
    return isChanged ? [{ id, current, isRemoved: false }] : [];
  });
};

/** Whether an entry with this outcome keeps the `Debugger` domain on: it is valid, has time left and has not expired. */
export const keepsDomainOn = (entry: ListedEntry, outcome: Outcome | undefined): boolean =>
  entry.kind === "valid" && entry.expiresInMs > 0 && outcome?.status !== "expired";
