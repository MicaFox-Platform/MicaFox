import { eventFrame, KEEPALIVE_FRAME, RESET_FRAME } from "./event.js";
import type { HubEvent } from "./event.js";

/** A stream keeps at most this many events it could not write yet; one more and it gets `reset`. */
export const MAX_UNDELIVERED = 100;

/** Where a stream writes: `write` answers false when the client is too slow to take more for now. */
export interface StreamSink {
  write: (chunk: string) => boolean;
  end: () => void;
}

/**
 * One open events stream of a user; it starts with `reset`. Events of the organizations in `orgIds`, which the
 * session's memberships gave when it opened, go out at once, and while the client is slow wait in a queue of at most
 * {@link MAX_UNDELIVERED}. A stream that falls further behind drops the queue and sends `reset` once the client
 * catches up, so it reloads what it missed; the hub keeps no history to replay.
 */
export class EventStream {
  readonly userId: string;
  private readonly orgIds: ReadonlySet<string>;
  private readonly sink: StreamSink;
  private isBlocked = false;
  private isEnded = false;
  private needsReset = false;
  private queue: string[] = [];

  constructor(params: { userId: string; orgIds: ReadonlySet<string>; sink: StreamSink }) {
    this.userId = params.userId;
    this.orgIds = params.orgIds;
    this.sink = params.sink;
    this.send(RESET_FRAME);
  }

  /** Sends `event` if it belongs to one of the stream's organizations, or keeps it while the client is slow. */
  offer(event: HubEvent): void {
    if (this.isEnded || this.needsReset || !this.orgIds.has(event.orgId)) {
      return;
    }
    if (!this.isBlocked) {
      this.send(eventFrame(event));
    } else if (this.queue.length < MAX_UNDELIVERED) {
      this.queue.push(eventFrame(event));
    } else {
      this.queue = [];
      this.needsReset = true;
    }
  }

  /** The client caught up: sends what was kept, or `reset` when the queue was dropped. */
  onDrain(): void {
    if (this.isEnded) {
      return;
    }
    this.isBlocked = false;
    if (this.needsReset) {
      this.needsReset = false;
      this.send(RESET_FRAME);
      return;
    }
    const pending = this.queue;
    this.queue = [];
    for (const [index, frame] of pending.entries()) {
      if (!this.send(frame)) {
        this.queue = pending.slice(index + 1);
        return;
      }
    }
  }

  /** Sends a comment, unless the client is behind already. */
  keepAlive(): void {
    if (!this.isEnded && !this.isBlocked) {
      this.send(KEEPALIVE_FRAME);
    }
  }

  /** Ends the stream; later calls do nothing. */
  end(): void {
    if (!this.isEnded) {
      this.isEnded = true;
      this.queue = [];
      this.sink.end();
    }
  }

  // Whether the client took the frame; if not, the stream waits for its drain
  private send(frame: string): boolean {
    const isTaken = this.sink.write(frame);
    this.isBlocked = !isTaken;
    return isTaken;
  }
}
