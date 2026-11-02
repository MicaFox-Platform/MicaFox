import { PROTOCOL_VERSION } from "@probex-platform/protocol";

import { Fifo } from "./fifo.js";

/** One serialized message waiting to be sent. */
export interface QueuedMessage {
  text: string;
  /** UTF-8 size of `text`. */
  bytes: number;
}

/** A count and a byte size that a queue or a batch may not exceed. */
export interface QueueLimits {
  maxMessages: number;
  maxBytes: number;
}

/** What adding a message did; the caller logs the drops. */
export interface AddOutcome {
  isQueued: boolean;
  /** How many older messages were dropped to make room. */
  droppedCount: number;
}

/** A batch ready to be written: one message as itself, or several as a `batch` frame. */
export interface OutgoingFrame {
  text: string;
  bytes: number;
}

interface BatchPlan {
  controlCount: number;
  dataCount: number;
  bytes: number;
}

// The control queue's bounds (docs/architecture/sdk/connector.md#sending-a-message)
const CONTROL_MAX_MESSAGES = 200;
const CONTROL_MAX_BYTES = 4096;

// The `batch` frame is built around the already serialized messages, so nothing is serialized twice. Its envelope is
// ASCII, so its length is its size in bytes.
const FRAME_START = `{"version":${String(PROTOCOL_VERSION)},"type":"batch","messages":[`;
const FRAME_END = "]}";
const FRAME_OVERHEAD_BYTES = FRAME_START.length + FRAME_END.length;

// One message goes as itself; several go in the envelope, separated by commas
const toFrameBytes = (count: number, messageBytes: number): number =>
  count === 1 ? messageBytes : FRAME_OVERHEAD_BYTES + messageBytes + count - 1;

// Removes and returns the first `count` messages of the control queue, in order. A Map keeps insertion order and
// replaces a key in place; V8 skips deleted entries on each iteration until it rehashes, which the cap of 200 keeps
// cheap. The data buffer, which has no such cap, is a Fifo instead.
const takeFirstControl = (queue: Map<string, QueuedMessage>, count: number): QueuedMessage[] => {
  const taken: QueuedMessage[] = [];
  for (const [key, message] of queue) {
    if (taken.length === count) {
      break;
    }

    taken.push(message);
    queue.delete(key);
  }

  return taken;
};

const takeFirstData = (queue: Fifo<QueuedMessage>, count: number): QueuedMessage[] =>
  Array.from({ length: count }, () => queue.shift()).filter((message) => message !== undefined);

const sumBytes = (messages: readonly QueuedMessage[]): number =>
  messages.reduce((total, message) => total + message.bytes, 0);

/**
 * The control queue and the data buffer, and which of their messages the next batch takes. Pure: no timers and no
 * I/O. Control messages always go first, and data never pushes one out.
 */
export class SendQueues {
  private readonly control = new Map<string, QueuedMessage>();
  private data = new Fifo<QueuedMessage>();
  private controlBytes = 0;
  private dataBytes = 0;

  constructor(
    private readonly buffer: QueueLimits,
    private readonly batch: QueueLimits,
  ) {}

  /** Messages waiting in both queues. */
  get size(): number {
    return this.control.size + this.data.size;
  }

  /** Tells whether the waiting messages fill a batch, by count or by the size of their frame, so it should go at once. */
  get isBatchFull(): boolean {
    const frameBytes = toFrameBytes(this.size, this.controlBytes + this.dataBytes);
    return this.size >= this.batch.maxMessages || frameBytes >= this.batch.maxBytes;
  }

  /**
   * Queues a control message under `key`: a message already waiting under the same key is replaced in its place. A
   * message over 4 KiB is not queued; with 200 waiting, the oldest is dropped.
   */
  addControl(key: string, message: QueuedMessage): AddOutcome {
    if (message.bytes > CONTROL_MAX_BYTES) {
      return { isQueued: false, droppedCount: 0 };
    }

    const replaced = this.control.get(key);
    if (replaced !== undefined) {
      this.controlBytes -= replaced.bytes;
    }

    const droppedCount = replaced === undefined && this.control.size >= CONTROL_MAX_MESSAGES ? 1 : 0;
    if (droppedCount === 1) {
      this.controlBytes -= sumBytes(takeFirstControl(this.control, 1));
    }

    this.control.set(key, message);
    this.controlBytes += message.bytes;
    return { isQueued: true, droppedCount };
  }

  /**
   * Queues a data message. One larger than `buffer.maxBytes` is not queued; otherwise the oldest are dropped until
   * it fits `buffer.maxMessages` and `buffer.maxBytes`.
   */
  addData(message: QueuedMessage): AddOutcome {
    if (message.bytes > this.buffer.maxBytes) {
      return { isQueued: false, droppedCount: 0 };
    }

    let droppedCount = 0;
    while (this.data.size >= this.buffer.maxMessages || this.dataBytes + message.bytes > this.buffer.maxBytes) {
      this.dataBytes -= sumBytes(takeFirstData(this.data, 1));
      droppedCount += 1;
    }

    this.data.push(message);
    this.dataBytes += message.bytes;
    return { isQueued: true, droppedCount };
  }

  /** Empties both queues and returns how many messages they held. */
  clear(): number {
    const count = this.size;
    this.control.clear();
    this.data = new Fifo<QueuedMessage>();
    this.controlBytes = 0;
    this.dataBytes = 0;
    return count;
  }

  /** The size of the frame `takeBatch()` would return now; `undefined` when nothing is waiting. */
  peekBatchBytes(): number | undefined {
    return this.planBatch()?.bytes;
  }

  /** Removes the next batch from the queues: control messages first, then data, up to the batch limits. */
  takeBatch(): OutgoingFrame | undefined {
    const plan = this.planBatch();
    if (plan === undefined) {
      return undefined;
    }

    const control = takeFirstControl(this.control, plan.controlCount);
    const data = takeFirstData(this.data, plan.dataCount);
    this.controlBytes -= sumBytes(control);
    this.dataBytes -= sumBytes(data);
    const texts = [...control, ...data].map((message) => message.text);
    const text = texts.length === 1 ? texts.join("") : `${FRAME_START}${texts.join(",")}${FRAME_END}`;
    return { text, bytes: plan.bytes };
  }

  // A batch is a prefix of the control queue, then a prefix of the data buffer: it stops at the first message that
  // does not fit. The first message always fits, so one larger than `batch.maxBytes` goes on its own. O(batch size).
  private planBatch(): BatchPlan | undefined {
    const plan: BatchPlan = { controlCount: 0, dataCount: 0, bytes: 0 };
    let messageBytes = 0;
    for (const [queue, field] of [
      [this.control.values(), "controlCount"],
      [this.data, "dataCount"],
    ] as const) {
      for (const message of queue) {
        const count = plan.controlCount + plan.dataCount + 1;
        const bytes = toFrameBytes(count, messageBytes + message.bytes);
        if (count > 1 && (count > this.batch.maxMessages || bytes > this.batch.maxBytes)) {
          return plan;
        }

        plan[field] += 1;
        plan.bytes = bytes;
        messageBytes += message.bytes;
      }
    }

    return plan.controlCount + plan.dataCount === 0 ? undefined : plan;
  }
}
