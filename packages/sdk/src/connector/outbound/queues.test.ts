import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { SendQueues, type QueuedMessage, type QueueLimits } from "./queues.js";

const LARGE: QueueLimits = { maxMessages: 1000, maxBytes: 1_048_576 };

const status = (breakpointId: string, state = "active"): QueuedMessage => {
  const text = JSON.stringify({ version: 1, type: "breakpointStatus", breakpointId, status: state });
  return { text, bytes: Buffer.byteLength(text) };
};

// A snapshot whose serialized size is exactly `bytes`
const snapshot = (name: string, bytes = 100): QueuedMessage => {
  const empty = JSON.stringify({ version: 1, type: "snapshot", breakpointId: name, pad: "" });
  const text = JSON.stringify({
    version: 1,
    type: "snapshot",
    breakpointId: name,
    pad: "x".repeat(bytes - empty.length),
  });
  return { text, bytes: Buffer.byteLength(text) };
};

const createSendQueues = ({
  buffer = LARGE,
  batch = LARGE,
}: { buffer?: QueueLimits; batch?: QueueLimits } = {}): SendQueues => new SendQueues(buffer, batch);

interface Sent {
  type: string;
  breakpointId: string;
  status?: string;
  messages?: Sent[];
}

const describeSent = ({ breakpointId, status: state }: Sent): string =>
  state === undefined ? breakpointId : `${breakpointId}:${state}`;

// The messages of every batch until the queues is empty, by breakpointId and status
const drain = (queues: SendQueues): string[][] => {
  const batches: string[][] = [];
  for (let frame = queues.takeBatch(); frame !== undefined; frame = queues.takeBatch()) {
    // The queues only holds what the tests serialized
    const sent = JSON.parse(frame.text) as Sent;
    batches.push((sent.type === "batch" ? (sent.messages ?? []) : [sent]).map((message) => describeSent(message)));
  }

  return batches;
};

const addControls = (queues: SendQueues, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    queues.addControl(`#${String(index)}`, status(`bp-${String(index)}`));
  }
};

describe("SendQueues control queue", () => {
  it("replaces a queued message with the same key in its place", () => {
    const queues = createSendQueues();
    queues.addControl("breakpointStatus:bp-1", status("bp-1", "pending"));
    queues.addControl("breakpointStatus:bp-2", status("bp-2", "pending"));

    const outcome = queues.addControl("breakpointStatus:bp-1", status("bp-1", "active"));

    expect({ outcome, batches: drain(queues) }).toEqual({
      outcome: { isQueued: true, droppedCount: 0 },
      batches: [["bp-1:active", "bp-2:pending"]],
    });
  });

  it("drops the oldest when 200 are waiting", () => {
    const queues = createSendQueues();
    addControls(queues, 200);

    const outcome = queues.addControl("#200", status("bp-200"));

    expect({ outcome, size: queues.size, first: drain(queues)[0]?.[0] }).toEqual({
      outcome: { isQueued: true, droppedCount: 1 },
      size: 200,
      first: "bp-1:active",
    });
  });

  it("does not queue a message over 4 KiB", () => {
    const queues = createSendQueues();

    const outcome = queues.addControl("#1", { text: "x".repeat(4097), bytes: 4097 });

    expect({ outcome, size: queues.size }).toEqual({ outcome: { isQueued: false, droppedCount: 0 }, size: 0 });
  });

  it("is never pushed out by data", () => {
    const queues = createSendQueues({ buffer: { maxMessages: 1, maxBytes: 1_048_576 } });
    queues.addControl("#1", status("bp-1"));

    queues.addData(snapshot("snap-1"));
    queues.addData(snapshot("snap-2"));

    expect(drain(queues)).toEqual([["bp-1:active", "snap-2"]]);
  });
});

describe("SendQueues data buffer", () => {
  it("drops the oldest when buffer.maxMessages are waiting", () => {
    const queues = createSendQueues({ buffer: { maxMessages: 2, maxBytes: 1_048_576 } });
    queues.addData(snapshot("snap-1"));
    queues.addData(snapshot("snap-2"));

    const outcome = queues.addData(snapshot("snap-3"));

    expect({ outcome, batches: drain(queues) }).toEqual({
      outcome: { isQueued: true, droppedCount: 1 },
      batches: [["snap-2", "snap-3"]],
    });
  });

  it("drops as many of the oldest as it takes to fit buffer.maxBytes", () => {
    const queues = createSendQueues({ buffer: { maxMessages: 1000, maxBytes: 300 } });
    queues.addData(snapshot("snap-1"));
    queues.addData(snapshot("snap-2"));
    queues.addData(snapshot("snap-3"));

    const outcome = queues.addData(snapshot("snap-4", 200));

    expect({ outcome, batches: drain(queues) }).toEqual({
      outcome: { isQueued: true, droppedCount: 2 },
      batches: [["snap-3", "snap-4"]],
    });
  });

  it("does not queue a message larger than buffer.maxBytes", () => {
    const queues = createSendQueues({ buffer: { maxMessages: 1000, maxBytes: 300 } });
    queues.addData(snapshot("snap-1"));

    const outcome = queues.addData(snapshot("snap-2", 301));

    expect({ outcome, batches: drain(queues) }).toEqual({
      outcome: { isQueued: false, droppedCount: 0 },
      batches: [["snap-1"]],
    });
  });
});

describe("SendQueues batches", () => {
  it("takes control messages first, then data", () => {
    const queues = createSendQueues();
    queues.addData(snapshot("snap-1"));
    queues.addControl("#1", status("bp-1"));

    const batches = drain(queues);

    expect(batches).toEqual([["bp-1:active", "snap-1"]]);
  });

  it("takes up to batch.maxMessages", () => {
    const queues = createSendQueues({ batch: { maxMessages: 2, maxBytes: 65_536 } });
    addControls(queues, 3);

    const batches = drain(queues);

    expect(batches).toEqual([["bp-0:active", "bp-1:active"], ["bp-2:active"]]);
  });

  // Two 100-byte messages make a 243-byte frame: the 42-byte envelope and one comma
  it.each([
    { maxBytes: 243, batches: [["snap-1", "snap-2"], ["snap-3"]] },
    { maxBytes: 242, batches: [["snap-1"], ["snap-2"], ["snap-3"]] },
  ])("keeps each frame within batch.maxBytes of $maxBytes, envelope included", ({ maxBytes, batches }) => {
    const queues = createSendQueues({ batch: { maxMessages: 100, maxBytes } });
    queues.addData(snapshot("snap-1"));
    queues.addData(snapshot("snap-2"));
    queues.addData(snapshot("snap-3"));

    const drained = drain(queues);

    expect(drained).toEqual(batches);
  });

  it("sends a message larger than batch.maxBytes on its own", () => {
    const queues = createSendQueues({ batch: { maxMessages: 100, maxBytes: 150 } });
    queues.addData(snapshot("snap-1", 400));
    queues.addData(snapshot("snap-2"));

    const batches = drain(queues);

    expect(batches).toEqual([["snap-1"], ["snap-2"]]);
  });

  it("sends one message as itself", () => {
    const queues = createSendQueues();
    const message = status("bp-1");
    queues.addControl("#1", message);

    const frame = queues.takeBatch();

    expect(frame).toEqual(message);
  });

  it("wraps several messages in a batch frame whose size is its UTF-8 length", () => {
    const queues = createSendQueues();
    queues.addControl("#1", status("bp-ü"));
    queues.addData(snapshot("snap-1"));

    const frame = queues.takeBatch();

    const text = frame?.text ?? "";
    expect({ parsed: JSON.parse(text) as unknown, bytes: frame?.bytes }).toEqual({
      parsed: {
        version: 1,
        type: "batch",
        messages: [JSON.parse(status("bp-ü").text), JSON.parse(snapshot("snap-1").text)],
      },
      bytes: Buffer.byteLength(text),
    });
  });

  it("peeks at the size of the next batch without taking it", () => {
    const queues = createSendQueues();
    queues.addData(snapshot("snap-1"));

    const peeked = queues.peekBatchBytes();

    expect({ peeked, taken: queues.takeBatch()?.bytes, empty: queues.peekBatchBytes() }).toEqual({
      peeked: 100,
      taken: 100,
      empty: undefined,
    });
  });

  it.each([
    { name: "batch.maxMessages", batch: { maxMessages: 2, maxBytes: 65_536 }, count: 2, isBatchFull: true },
    // Two 100-byte messages make a 243-byte frame, envelope included
    { name: "a frame of batch.maxBytes", batch: { maxMessages: 100, maxBytes: 243 }, count: 2, isBatchFull: true },
    { name: "a frame under batch.maxBytes", batch: { maxMessages: 100, maxBytes: 244 }, count: 2, isBatchFull: false },
    { name: "neither limit", batch: { maxMessages: 3, maxBytes: 65_536 }, count: 2, isBatchFull: false },
  ])("tells whether the waiting messages fill a batch by $name", ({ batch, count, isBatchFull }) => {
    const queues = createSendQueues({ batch });

    Array.from({ length: count }, (_, index) => queues.addData(snapshot(`snap-${String(index)}`)));

    expect(queues.isBatchFull).toBe(isBatchFull);
  });
});

describe("SendQueues clear()", () => {
  it("returns how many messages both queues held and leaves them empty", () => {
    const queues = createSendQueues();
    queues.addControl("a", status("bp-1"));
    queues.addData(snapshot("bp-2"));
    queues.addData(snapshot("bp-3"));

    const count = queues.clear();

    expect({ count, size: queues.size, next: queues.takeBatch() }).toEqual({ count: 3, size: 0, next: undefined });
  });

  it("forgets the cleared bytes, so a batch after it holds only new messages", () => {
    const queues = createSendQueues({ batch: { maxMessages: 1000, maxBytes: 300 } });
    queues.addData(snapshot("bp-1", 250));
    queues.clear();
    queues.addData(snapshot("bp-2", 100));
    queues.addData(snapshot("bp-3", 100));

    const batches = drain(queues);

    expect(batches).toEqual([["bp-2", "bp-3"]]);
  });
});
