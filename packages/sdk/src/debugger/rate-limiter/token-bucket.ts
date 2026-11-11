/**
 * Holds up to `perSecond` tokens, refilled continuously at `perSecond` per second, so a full bucket is one second of
 * use. It may go into debt, and then refills from there. Pure: time comes from `now`.
 */
export class TokenBucket {
  private tokens: number;
  private refilledAt: number;

  /** `now` is a monotonic clock in milliseconds: the wall clock steps on NTP corrections. Starts full. */
  constructor(
    private readonly perSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = perSecond;
    this.refilledAt = now();
  }

  /** The tokens it holds now, below 0 in debt. */
  level(): number {
    this.refill();
    return this.tokens;
  }

  /** Takes `amount` tokens, also more than it holds. */
  take(amount: number): void {
    this.refill();
    this.tokens -= amount;
  }

  /** Milliseconds until it is full; 0 when it is. */
  msUntilFull(): number {
    this.refill();
    return ((this.perSecond - this.tokens) * 1000) / this.perSecond;
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.refilledAt);
    this.refilledAt = now;
    this.tokens = Math.min(this.perSecond, this.tokens + (elapsedMs * this.perSecond) / 1000);
  }
}
