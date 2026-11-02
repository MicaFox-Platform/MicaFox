/** Reconnect delays: from `minDelayMs`, doubled per failed attempt up to `maxDelayMs`, each wait jittered. */
export class Backoff {
  private delayMs: number;

  constructor(
    private readonly minDelayMs: number,
    private readonly maxDelayMs: number,
  ) {
    this.delayMs = minDelayMs;
  }

  /** Returns the wait before the next attempt, random within [½, 1] × the current delay, then doubles the delay. */
  nextWaitMs(): number {
    // Jitter spreads out a fleet of apps that lost the same hub at the same moment
    const waitMs = this.delayMs * (0.5 + 0.5 * Math.random());
    this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
    return waitMs;
  }

  /** The hub rejected the session: retry slowly until it is fixed. */
  jumpToMax(): void {
    this.delayMs = this.maxDelayMs;
  }

  /** The hub accepted a session. */
  reset(): void {
    this.delayMs = this.minDelayMs;
  }
}
