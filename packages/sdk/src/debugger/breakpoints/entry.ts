import type { CaptureLimits } from "@probex-platform/protocol";

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
