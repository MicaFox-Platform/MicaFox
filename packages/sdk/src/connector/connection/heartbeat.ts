/** What a heartbeat does to the socket it watches; both are called from timers. */
export interface HeartbeatActions {
  ping(): void;
  /** The hub sent nothing within 10 s of a ping. */
  onSilence(): void;
}

// The protocol's limits: docs/api/protocol.md (On the wire)
const PING_INTERVAL_MS = 15_000;
const SILENCE_TIMEOUT_MS = 10_000;

/**
 * Pings the hub every 15 s and reports a hub that sends nothing back within 10 s, so a half-open connection that
 * never errors is dropped (ADR 0008). Its timers are unref'd.
 */
export class Heartbeat {
  private pingTimer: NodeJS.Timeout | undefined;
  private silenceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly actions: HeartbeatActions) {}

  /** Schedules the first ping; call it once the socket is open. */
  start(): void {
    this.pingTimer = setTimeout(() => {
      this.beat();
    }, PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  /** Something arrived from the hub, so it is alive. */
  onActivity(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  stop(): void {
    clearTimeout(this.pingTimer);
    clearTimeout(this.silenceTimer);
  }

  private beat(): void {
    this.start();
    // The silence timeout is shorter than the interval, so a silent hub is reported before the next ping
    this.silenceTimer = setTimeout(() => {
      this.actions.onSilence();
    }, SILENCE_TIMEOUT_MS);
    this.silenceTimer.unref();
    this.actions.ping();
  }
}
