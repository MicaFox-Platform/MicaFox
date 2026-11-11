import { PROTOCOL_VERSION, type BreakpointStatus, type CaptureLimits } from "@micafox/protocol";

/** An entry of a `breakpoints` message whose fields are valid. */
export interface ValidEntry {
  kind: "valid";
  id: string;
  file: string;
  /** 1-based, as the hub sends it. */
  line: number;
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
 * What became of an entry. `place` names its V8 breakpoint, and `mapUrl` the URL of the script whose map placed it,
 * which holds that map. A retryable error came from a map that could not be used and is resolved again like a
 * pending entry.
 */
export type Outcome =
  | { status: "pending" }
  | { status: "active"; place: string; mapUrl?: string }
  | { status: "error"; message: string; isRetryable?: boolean };

/** Whether a later script may still change the outcome: it is pending, or an error that is retried. */
export const isUnresolved = (outcome: Outcome): boolean =>
  outcome.status === "pending" || (outcome.status === "error" && outcome.isRetryable === true);

/** Whether two outcomes send the same status. */
export const isSameStatus = (first: Outcome, second: Outcome): boolean =>
  first.status === second.status &&
  (first.status !== "error" || (second.status === "error" && first.message === second.message));

/** How many of `outcomes` have each status, such as `1 active, 2 pending, 0 error`. */
export const summarizeOutcomes = (outcomes: readonly Outcome[]): string => {
  const counts = { active: 0, pending: 0, error: 0 };
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
  }

  return `${String(counts.active)} active, ${String(counts.pending)} pending, ${String(counts.error)} error`;
};

/** The `breakpointStatus` message of an entry's outcome. */
export const toStatus = (breakpointId: string, outcome: Outcome): BreakpointStatus => {
  const base = { version: PROTOCOL_VERSION, type: "breakpointStatus", breakpointId } as const;
  return outcome.status === "error"
    ? { ...base, status: "error", message: outcome.message }
    : { ...base, status: outcome.status };
};

const isSameLimits = (first: CaptureLimits | undefined, second: CaptureLimits | undefined): boolean =>
  first?.maxDepth === second?.maxDepth &&
  first?.maxItems === second?.maxItems &&
  first?.maxStringLength === second?.maxStringLength;

/** Tells whether `next` leaves the breakpoint of `current` as it is: the same `file`, `line` and `limits`. */
export const isSameEntry = (current: ListedEntry, next: ListedEntry): boolean => {
  if (current.kind === "invalid" || next.kind === "invalid") {
    return current.kind === "invalid" && next.kind === "invalid" && current.message === next.message;
  }

  return current.file === next.file && current.line === next.line && isSameLimits(current.limits, next.limits);
};
