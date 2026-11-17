import type { Message } from "@micafox/protocol";
import { Buffer } from "node:buffer";

import { SendQueues, type AddOutcome, type QueueLimits } from "./queues.js";
import { TokenBucket } from "./token-bucket.js";
import { readErrorCode, type SdkLogger } from "../../logger/index.js";

/** Where the batcher writes: the socket of an attempt the hub has welcomed. */
export interface BatchTarget {
  /** Tells whether the socket is open; a closing one would silently drop what it is handed. */
  isOpen(): boolean;
  /** Bytes handed to the socket and not written out yet. */
  unsentBytes(): number;
  /** Writes `text` as one frame; `onWritten` runs once the socket has written it or failed to. */
  write(text: string, onWritten: () => void): void;
}

/** The resolved options the batcher uses. */
export interface BatcherSettings {
  buffer: QueueLimits;
  batch: QueueLimits & { flushIntervalMs: number };
  rateLimit: { bytesPerSecond: number };
}

/** What the batcher needs from its connector. */
export interface BatcherDependencies {
  logger: SdkLogger;
  /** A monotonic clock in milliseconds, for the rate limit. */
  now: () => number;
  /** Reports a bug in the batcher, caught in a timer or socket callback. */
  onInternalError: (error: unknown) => void;
}

type Serialized = { ok: true; text: string } | { ok: false; code: string | undefined };

const COMPONENT = "connector";
// The debugger's snapshots are data; every other message, including one a module adds later, is control. Types are
// unique within a module only, so the module is part of the name.
const DATA_MESSAGES: ReadonlySet<string> = new Set(["debugger/snapshot"]);

// Read defensively: an app in plain JavaScript can pass anything
const readMessageField = (message: unknown, name: string): unknown =>
  typeof message === "object" && message !== null ? Reflect.get(message, name) : undefined;

// JSON.stringify returns undefined for a value JSON cannot hold, such as a function, and throws on a cycle, a BigInt
// or a throwing toJSON()
const serialize = (message: unknown): Serialized => {
  try {
    const text: unknown = JSON.stringify(message);
    return typeof text === "string" ? { ok: true, text } : { ok: false, code: undefined };
  } catch (error) {
    return { ok: false, code: readErrorCode(error) };
  }
};

/**
 * Queues the messages of `send()` and writes them in batches while a welcomed attempt is attached, within the rate
 * limit and the socket's backpressure. `enqueue()` only serializes and queues; batches are built and written from an
 * unref'd timer or `setImmediate`, or at once by `drain()` when the connector closes.
 */
export class Batcher {
  private readonly queues: SendQueues;
  private readonly bucket: TokenBucket;
  private target: BatchTarget | undefined;
  // The modules the attached session carries; what a batch takes from other modules is dropped
  private modules: ReadonlySet<string> = new Set();
  private timer: NodeJS.Timeout | undefined;
  private immediate: NodeJS.Immediate | undefined;
  private isWaitingForWrite = false;
  private isWaitingForRate = false;
  private nextControlId = 0;
  private onDrained: (() => void) | undefined;

  constructor(
    private readonly settings: BatcherSettings,
    private readonly dependencies: BatcherDependencies,
  ) {
    this.queues = new SendQueues(settings.buffer, settings.batch);
    this.bucket = new TokenBucket(settings.rateLimit.bytesPerSecond, dependencies.now);
  }

  /** Serializes `message` once and queues it; drops it with a log line when it cannot be queued. */
  enqueue(message: Message): void {
    const type = readMessageField(message, "type");
    if (type === "hello") {
      this.log("warn", "a hello message was dropped: the connector sends its own", "send-hello");
      return;
    }

    const serialized = serialize(message);
    if (!serialized.ok) {
      const code = serialized.code === undefined ? "" : ` (${serialized.code})`;
      this.log("error", `a message that cannot be serialized was dropped${code}`, "send-unserializable");
      return;
    }

    const module = readMessageField(message, "module");
    const queued = {
      text: serialized.text,
      module: typeof module === "string" ? module : undefined,
      bytes: Buffer.byteLength(serialized.text),
    };
    if (typeof module === "string" && typeof type === "string" && DATA_MESSAGES.has(`${module}/${type}`)) {
      this.reportData(this.queues.addData(queued));
    } else {
      this.reportControl(this.queues.addControl(this.toControlKey(message, queued.module, type), queued));
    }

    this.schedule();
  }

  /** Starts writing to `target`, the attempt the hub has just welcomed; only messages of `modules` are sent. */
  attach(target: BatchTarget, modules: ReadonlySet<string>): void {
    this.target = target;
    this.modules = modules;
    this.schedule();
  }

  /** Stops writing: queued messages wait for the next `attach()`, and a pending `drain()` resolves. */
  detach(): void {
    this.target = undefined;
    this.modules = new Set();
    this.isWaitingForWrite = false;
    this.clearTimers();
    this.onDrained?.();
    this.onDrained = undefined;
  }

  /**
   * For `close()`: writes everything queued to `target` at once, within the rate limit and the socket's backpressure.
   * Resolves once nothing is left or the socket is no longer open; the caller bounds how long it waits.
   */
  drain(target: BatchTarget, modules: ReadonlySet<string>): Promise<void> {
    this.clearTimers();
    this.isWaitingForWrite = false;
    this.target = target;
    this.modules = modules;
    return new Promise((resolve) => {
      this.onDrained = resolve;
      this.flushSafely();
    });
  }

  /** Empties the queues and returns how many messages were dropped. */
  discard(): number {
    return this.queues.clear();
  }

  // A breakpoint's newer status takes the place of its queued one; every other control message is kept on its own
  private toControlKey(message: Message, module: string | undefined, type: unknown): string {
    const breakpointId = type === "breakpointStatus" ? readMessageField(message, "breakpointId") : undefined;
    if (module !== undefined && typeof breakpointId === "string") {
      return `${module}/breakpointStatus:${breakpointId}`;
    }

    this.nextControlId += 1;
    return `#${String(this.nextControlId)}`;
  }

  private reportData({ isQueued, droppedCount }: AddOutcome): void {
    if (!isQueued) {
      this.log("warn", "a snapshot larger than buffer.maxBytes was dropped", "send-data-too-large");
    } else if (droppedCount > 0) {
      this.log("warn", "the data buffer is full: the oldest snapshots were dropped", "send-data-full");
    }
  }

  private reportControl({ isQueued, droppedCount }: AddOutcome): void {
    if (!isQueued) {
      this.log("warn", "a control message over 4 KiB was dropped", "send-control-too-large");
    } else if (droppedCount > 0) {
      this.log("warn", "the control queue is full: the oldest control message was dropped", "send-control-full");
    }
  }

  // At once when a batch is full, otherwise `batch.flushIntervalMs` after the first queued message. While a rate
  // wait or a write is pending, that resumes the flush instead: a batch is built only then, so a newer control
  // message still goes first, and planning it earlier would be wasted work.
  private schedule(): void {
    if (this.target === undefined || this.queues.size === 0 || this.isWaiting()) {
      return;
    }

    if (this.queues.isBatchFull) {
      this.immediate = setImmediate(() => {
        this.flushSafely();
      });
      this.immediate.unref();
      return;
    }

    if (this.timer === undefined) {
      this.startTimer(this.settings.batch.flushIntervalMs);
    }
  }

  // Timer and socket callbacks are a boundary: a throw there would crash the host app
  private flushSafely(): void {
    try {
      this.flush();
    } catch (error) {
      this.dependencies.onInternalError(error);
      // Nothing is left to resume a drain after a failure, so close() goes on without waiting for its timeout
      this.onDrained?.();
      this.onDrained = undefined;
    }
  }

  private flush(): void {
    this.clearTimers();
    const target = this.target;
    let hasWritten = target !== undefined;
    while (target !== undefined && hasWritten) {
      hasWritten = this.writeNext(target);
    }

    this.settleDrain();
  }

  // A drain is over when nothing is left to write or nothing more can be written; a pending rate wait or write
  // resumes it otherwise
  private settleDrain(): void {
    const target = this.target;
    if (this.onDrained === undefined || (target?.isOpen() === true && this.queues.size > 0)) {
      return;
    }

    this.onDrained();
    this.onDrained = undefined;
  }

  // Writes one batch, or sets up what resumes the flush: the write callback when the socket has a batch's worth
  // unsent, a timer when the rate limit needs time. Batches are built only now, so a newer control message goes first.
  // A closing socket gets nothing: its attempt is about to end, and the messages wait for the next `welcome`, or are
  // dropped when the connector itself is closing.
  private writeNext(target: BatchTarget): boolean {
    if (!target.isOpen()) {
      return false;
    }

    if (target.unsentBytes() >= this.settings.batch.maxBytes) {
      this.isWaitingForWrite = true;
      return false;
    }

    const bytes = this.queues.peekBatchBytes(this.modules);
    if (bytes === undefined) {
      // Nothing of the session's modules is waiting; taking drops what is left, which none of them own
      this.queues.takeBatch(this.modules);
      return false;
    }

    const waitMs = this.bucket.waitMs(bytes);
    if (waitMs > 0) {
      this.startTimer(waitMs);
      this.isWaitingForRate = true;
      return false;
    }

    const frame = this.queues.takeBatch(this.modules);
    if (frame === undefined) {
      return false;
    }

    this.bucket.take(frame.bytes);
    target.write(frame.text, () => {
      this.onWritten(target);
    });
    return true;
  }

  private onWritten(target: BatchTarget): void {
    if (target !== this.target || !this.isWaitingForWrite) {
      return;
    }

    this.isWaitingForWrite = false;
    this.flushSafely();
  }

  private startTimer(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.flushSafely();
    }, delayMs);
    this.timer.unref();
  }

  private isWaiting(): boolean {
    return this.immediate !== undefined || this.isWaitingForRate || this.isWaitingForWrite;
  }

  private clearTimers(): void {
    this.isWaitingForRate = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearImmediate(this.immediate);
    this.immediate = undefined;
  }

  private log(level: "warn" | "error", message: string, key: string): void {
    this.dependencies.logger.log(level, message, { component: COMPONENT, key });
  }
}
