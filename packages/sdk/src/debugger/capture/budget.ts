import type { Value } from "@probex-platform/protocol";
import { Buffer } from "node:buffer";

/** The time and size a capture may use. */
export interface BudgetLimits {
  maxMs: number;
  maxBytes: number;
}

/** 10 ms and 64 KiB, the most a pause and a snapshot may take. */
export const DEFAULT_BUDGET: BudgetLimits = { maxMs: 10, maxBytes: 64 * 1024 };

// The JSON of a node apart from its text: braces, quotes, the keys of its fields and a separator
const NODE_BYTES = 40;

// The bytes a value adds to the snapshot's JSON, its children left out: they are charged when they are built
const sizeOfOwnFields = (value: Value): number => {
  if (value.type === "string") {
    return Buffer.byteLength(value.value);
  }

  if (value.type === "bigint" || value.type === "symbol" || value.type === "date") {
    return value.value.length;
  }

  if (value.type === "function") {
    return value.name.length;
  }

  if (value.type === "error") {
    return value.className.length + Buffer.byteLength(value.message) + Buffer.byteLength(value.stack ?? "");
  }

  if (value.type === "object") {
    return value.className.length;
  }

  return value.type === "unavailable" ? value.reason.length : 0;
};

/** The approximate bytes of `value`'s JSON without its children. O(length of its text). */
export const sizeOf = (value: Value): number => NODE_BYTES + sizeOfOwnFields(value);

/**
 * What one capture may still spend: the time since it started and the bytes of the snapshot so far. Once either
 * is used up, `exhaustedReason()` says why and stays set.
 */
export class CaptureBudget {
  private readonly startedMs: number;
  private usedBytes = 0;
  private reason: string | undefined;
  private isCut = false;

  constructor(
    private readonly now: () => number,
    private readonly limits: BudgetLimits,
  ) {
    this.startedMs = now();
  }

  /** Counts `bytes` of the snapshot. */
  charge(bytes: number): void {
    this.usedBytes += bytes;
  }

  /** Why nothing more may be read, or undefined while there is budget left. */
  exhaustedReason(): string | undefined {
    if (this.reason !== undefined) {
      return this.reason;
    }

    if (this.usedBytes >= this.limits.maxBytes) {
      this.reason = "the snapshot reached its size limit";
    } else if (this.now() - this.startedMs >= this.limits.maxMs) {
      this.reason = "the pause reached its time limit";
    }

    return this.reason;
  }

  /** Why the next value may not be read, or undefined while there is budget left; a reason truncates the read. */
  stopReason(): string | undefined {
    const reason = this.exhaustedReason();
    if (reason !== undefined) {
      this.isCut = true;
    }

    return reason;
  }

  /** Whether any value was left unread because the budget ran out. */
  get wasCut(): boolean {
    return this.isCut;
  }
}
