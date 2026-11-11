import { TokenBucket } from "./token-bucket.js";

/** Snapshots a second per breakpoint, in a burst of one second. */
const ENTRY_PER_SECOND = 10;
/** Snapshots a second for the whole process. */
const PROCESS_PER_SECOND = 50;
/** Milliseconds a second the app may spend paused. */
const BUDGET_MS_PER_SECOND = 20;

/** Which entries of one pause may capture, and which are out of their own tokens. */
export interface Admission {
  allowed: string[];
  outOfTokens: string[];
}

/**
 * The token bucket of each breakpoint, the process's bucket and the pause budget
 * (docs/architecture/sdk/debugger.md#capturing-a-snapshot). Pure: time comes from `now`, a monotonic clock in
 * milliseconds. Holds one bucket per listed breakpoint, at most 100, and forgets one when it is no longer listed.
 */
export class RateLimiter {
  private readonly entries = new Map<string, TokenBucket>();
  private readonly process: TokenBucket;
  private readonly budget: TokenBucket;

  constructor(private readonly now: () => number) {
    this.process = new TokenBucket(PROCESS_PER_SECOND, now);
    this.budget = new TokenBucket(BUDGET_MS_PER_SECOND, now);
  }

  /** Lets an entry capture if it has a token, the process has one and the budget is not spent; it takes one of each. */
  admit(ids: readonly string[]): Admission {
    const admission: Admission = { allowed: [], outOfTokens: [] };
    for (const id of ids) {
      const bucket = this.bucketOf(id);
      if (bucket.level() < 1) {
        admission.outOfTokens.push(id);
        continue;
      }

      if (this.isSpent()) {
        continue;
      }

      bucket.take(1);
      this.process.take(1);
      admission.allowed.push(id);
    }

    return admission;
  }

  /** Charges the time a pause took to the budget, which may go into debt. */
  charge(pauseMs: number): void {
    this.budget.take(pauseMs);
  }

  /** Whether the process is out of tokens or the budget is spent, so no entry may capture. */
  isSpent(): boolean {
    return this.process.level() < 1 || this.budget.level() <= 0;
  }

  /** Milliseconds until the entry's bucket is full; 0 for an entry without one. */
  msUntilEntryFull(id: string): number {
    return this.entries.get(id)?.msUntilFull() ?? 0;
  }

  /** Milliseconds until both the process's bucket and the budget are full. */
  msUntilProcessFull(): number {
    return Math.max(this.process.msUntilFull(), this.budget.msUntilFull());
  }

  /** Drops the bucket of an entry that is no longer listed. */
  forget(id: string): void {
    this.entries.delete(id);
  }

  private bucketOf(id: string): TokenBucket {
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      return existing;
    }

    const created = new TokenBucket(ENTRY_PER_SECOND, this.now);
    this.entries.set(id, created);
    return created;
  }
}
