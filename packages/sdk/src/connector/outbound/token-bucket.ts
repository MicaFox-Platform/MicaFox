/**
 * Paces outgoing frames to `bytesPerSecond` on average, with bursts of up to one second's worth. A frame larger than
 * that waits for a full bucket and leaves it in debt, so it is delayed, never stuck. Pure: time comes from `now`.
 */
export class TokenBucket {
  private tokens: number;
  private refilledAt: number;

  /** `now` is a monotonic clock in milliseconds: the wall clock steps on NTP corrections. Starts full. */
  constructor(
    private readonly bytesPerSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = bytesPerSecond;
    this.refilledAt = now();
  }

  /** How long a frame of `bytes` has to wait before it may go; 0 when it may go now. */
  waitMs(bytes: number): number {
    this.refill();
    const needed = Math.min(bytes, this.bytesPerSecond);
    if (this.tokens >= needed) {
      return 0;
    }

    // Rounded up, so the bucket holds enough once the wait is over
    return Math.ceil(((needed - this.tokens) * 1000) / this.bytesPerSecond);
  }

  /** Spends `bytes` on a frame that goes now; the bucket may go into debt. */
  take(bytes: number): void {
    this.refill();
    this.tokens -= bytes;
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.refilledAt);
    this.refilledAt = now;
    this.tokens = Math.min(this.bytesPerSecond, this.tokens + (elapsedMs * this.bytesPerSecond) / 1000);
  }
}
