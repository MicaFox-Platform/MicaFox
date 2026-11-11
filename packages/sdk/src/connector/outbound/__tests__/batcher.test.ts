import type { Message, Snapshot } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "../../../logger/index.js";
import { Batcher, type BatchTarget, type BatcherSettings } from "../batcher.js";

const PREFIX = "[micafox] connector: ";

/** A socket stand-in: records each frame with the fake time it was written, and finishes writes on demand. */
interface FakeTarget extends BatchTarget {
  readonly frames: Array<{ atMs: number; ids: string[] }>;
  open: boolean;
  unsent: number;
  /** Empties the socket and runs every pending write callback. */
  finishWrites(): void;
}

interface Sent {
  type: string;
  breakpointId?: string;
  status?: string;
  messages?: Sent[];
}

// A frame by what identifies each message in it: the breakpointId, or the type when there is none
const toIds = (text: string): string[] => {
  // The batcher only writes what the tests serialized
  const sent = JSON.parse(text) as Sent;
  const messages = sent.type === "batch" ? (sent.messages ?? []) : [sent];
  return messages.map((message) => message.breakpointId ?? message.type);
};

const createTarget = (): FakeTarget => {
  const pending: Array<() => void> = [];
  const target: FakeTarget = {
    frames: [],
    open: true,
    unsent: 0,
    isOpen: () => target.open,
    unsentBytes: () => target.unsent,
    write: (text, onWritten) => {
      target.frames.push({ atMs: Date.now(), ids: toIds(text) });
      pending.push(onWritten);
    },
    finishWrites: () => {
      target.unsent = 0;
      for (const onWritten of pending.splice(0)) {
        onWritten();
      }
    },
  };
  return target;
};

interface SettingsOverrides {
  buffer?: Partial<BatcherSettings["buffer"]>;
  batch?: Partial<BatcherSettings["batch"]>;
  bytesPerSecond?: number;
}

const createBatcher = ({ buffer, batch, bytesPerSecond = 1_048_576 }: SettingsOverrides = {}) => {
  const lines: string[] = [];
  const record = (message: string): void => {
    lines.push(message.replace(PREFIX, ""));
  };
  const console: Logger = { debug: record, info: record, warn: record, error: record };
  const internalErrors: unknown[] = [];
  const batcher = new Batcher(
    {
      buffer: { maxMessages: 1000, maxBytes: 1_048_576, ...buffer },
      batch: { maxMessages: 100, maxBytes: 65_536, flushIntervalMs: 100, ...batch },
      rateLimit: { bytesPerSecond },
    },
    {
      logger: createLogger({ component: "connector", env: {}, console }),
      now: () => Date.now(),
      onInternalError: (error) => internalErrors.push(error),
    },
  );
  return { batcher, lines, internalErrors };
};

const status = (breakpointId: string, state: "pending" | "active" = "active", message?: string): Message =>
  message === undefined
    ? { version: 1, type: "breakpointStatus", breakpointId, status: state }
    : { version: 1, type: "breakpointStatus", breakpointId, status: state, message };

// A snapshot whose serialized size is exactly `bytes`
const snapshot = (breakpointId: string, bytes = 200): Message => {
  const base: Snapshot = { version: 1, type: "snapshot", breakpointId, time: 0, stack: [], variables: [] };
  const padding = bytes - JSON.stringify({ ...base, variables: [{ name: "", value: { type: "undefined" } }] }).length;
  return { ...base, variables: [{ name: "x".repeat(padding), value: { type: "undefined" } }] };
};

const enqueueAll = (batcher: Batcher, messages: readonly Message[]): void => {
  for (const message of messages) {
    batcher.enqueue(message);
  }
};

const createCyclic = (): Message => {
  const message: Message & { self?: object } = status("bp-1");
  message.self = message;
  return message;
};

const statuses = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => status(`bp-${String(index)}`));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date"], now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Batcher queueing", () => {
  it("serializes a message once, however long it waits", () => {
    const { batcher } = createBatcher();
    let serializations = 0;
    const message = {
      ...status("bp-1"),
      toJSON: () => {
        serializations += 1;
        return status("bp-1");
      },
    };
    batcher.enqueue(message);
    batcher.attach(createTarget());

    vi.advanceTimersByTime(1000);

    expect(serializations).toBe(1);
  });

  it("writes nothing from enqueue() itself, even when a batch is full", () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 1 } });
    const target = createTarget();
    batcher.attach(target);

    batcher.enqueue(status("bp-1"));

    const written = target.frames.length;
    vi.advanceTimersToNextTimer();
    expect({ written, later: target.frames }).toEqual({ written: 0, later: [{ atMs: 0, ids: ["bp-1"] }] });
  });

  it("drops a hello with a warning: the connector sends its own", () => {
    const { batcher, lines } = createBatcher();
    const target = createTarget();
    batcher.attach(target);
    const hello = { version: 1, type: "hello" } as unknown as Message;

    batcher.enqueue(hello);

    vi.advanceTimersByTime(1000);
    expect({ lines, frames: target.frames }).toEqual({
      lines: ["a hello message was dropped: the connector sends its own"],
      frames: [],
    });
  });

  it.each([
    { name: "a cycle", message: createCyclic(), line: "" },
    {
      name: "a throwing toJSON()",
      message: {
        ...status("bp-1"),
        toJSON: () => {
          throw Object.assign(new Error("toJSON failed"), { code: "ERR_TEST_JSON" });
        },
      },
      line: " (ERR_TEST_JSON)",
    },
    { name: "undefined", message: undefined, line: "" },
  ])("drops a message it cannot serialize, with $name, and logs an error", ({ message, line }) => {
    const { batcher, lines } = createBatcher();
    const target = createTarget();
    batcher.attach(target);

    batcher.enqueue(message as unknown as Message);

    vi.advanceTimersByTime(1000);
    expect({ lines, frames: target.frames }).toEqual({
      lines: [`a message that cannot be serialized was dropped${line}`],
      frames: [],
    });
  });

  it("keeps messages until a target is attached", () => {
    const { batcher } = createBatcher();
    const target = createTarget();
    batcher.enqueue(status("bp-1"));
    vi.advanceTimersByTime(1000);

    batcher.attach(target);

    vi.advanceTimersByTime(1000);
    expect(target.frames).toEqual([{ atMs: 1100, ids: ["bp-1"] }]);
  });

  it("keeps queued messages across a detach, and never writes a message twice", () => {
    const { batcher } = createBatcher();
    const first = createTarget();
    const second = createTarget();
    batcher.attach(first);
    batcher.enqueue(status("bp-1"));
    vi.advanceTimersByTime(100);
    batcher.detach();
    batcher.enqueue(status("bp-2"));

    batcher.attach(second);

    vi.advanceTimersByTime(100);
    expect({ first: first.frames, second: second.frames }).toEqual({
      first: [{ atMs: 100, ids: ["bp-1"] }],
      second: [{ atMs: 200, ids: ["bp-2"] }],
    });
  });

  it("lets a newer status of a breakpoint take the place of its queued one", () => {
    const { batcher } = createBatcher();
    const target = createTarget();
    batcher.attach(target);

    enqueueAll(batcher, [status("bp-1", "pending"), status("bp-2", "pending"), status("bp-1", "active")]);

    vi.advanceTimersByTime(100);
    expect(target.frames).toEqual([{ atMs: 100, ids: ["bp-1", "bp-2"] }]);
  });

  it("sends every type but snapshot as control, before data queued earlier", () => {
    const { batcher } = createBatcher();
    const target = createTarget();
    batcher.attach(target);
    const custom = { version: 1, type: "custom" } as unknown as Message;

    enqueueAll(batcher, [snapshot("snap-1"), custom, status("bp-1")]);

    vi.advanceTimersByTime(100);
    expect(target.frames).toEqual([{ atMs: 100, ids: ["custom", "bp-1", "snap-1"] }]);
  });

  it.each([
    {
      name: "a snapshot larger than buffer.maxBytes",
      messages: [snapshot("snap-1", 501)],
      line: "a snapshot larger than buffer.maxBytes was dropped",
    },
    {
      name: "the oldest snapshot when the data buffer is full",
      messages: [snapshot("snap-1", 300), snapshot("snap-2", 300)],
      line: "the data buffer is full: the oldest snapshots were dropped",
    },
    {
      name: "a control message over 4 KiB",
      messages: [status("bp-1", "active", "x".repeat(4096))],
      line: "a control message over 4 KiB was dropped",
    },
    {
      name: "the oldest control message when 200 are waiting",
      messages: statuses(201),
      line: "the control queue is full: the oldest control message was dropped",
    },
  ])("drops $name with a warning", ({ messages, line }) => {
    const { batcher, lines } = createBatcher({ buffer: { maxBytes: 500 } });

    enqueueAll(batcher, messages);

    expect(lines).toEqual([line]);
  });
});

describe("Batcher batching and pacing", () => {
  it("writes a batch batch.flushIntervalMs after the first queued message", () => {
    const { batcher } = createBatcher();
    const target = createTarget();
    batcher.attach(target);
    batcher.enqueue(status("bp-1"));
    vi.advanceTimersByTime(60);

    batcher.enqueue(status("bp-2"));

    vi.advanceTimersByTime(60);
    expect(target.frames).toEqual([{ atMs: 100, ids: ["bp-1", "bp-2"] }]);
  });

  it("writes at once from setImmediate when batch.maxBytes are queued", () => {
    const { batcher } = createBatcher({ batch: { maxBytes: 300 } });
    const target = createTarget();
    batcher.attach(target);
    batcher.enqueue(snapshot("snap-1"));

    batcher.enqueue(snapshot("snap-2"));

    vi.advanceTimersToNextTimer();
    expect(target.frames).toEqual([
      { atMs: 0, ids: ["snap-1"] },
      { atMs: 0, ids: ["snap-2"] },
    ]);
  });

  it("waits while the socket has batch.maxBytes unsent, and resumes once it writes them", () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 1, maxBytes: 1000 } });
    const target = createTarget();
    batcher.attach(target);
    batcher.enqueue(status("bp-1"));
    vi.advanceTimersByTime(100);
    target.unsent = 1000;
    batcher.enqueue(status("bp-2"));
    vi.advanceTimersByTime(1000);
    const whileFull = target.frames.map((frame) => frame.ids);

    target.finishWrites();

    expect({ whileFull, after: target.frames.map((frame) => frame.ids) }).toEqual({
      whileFull: [["bp-1"]],
      after: [["bp-1"], ["bp-2"]],
    });
  });

  it("paces frames by the rate limit, and a frame larger than the bucket leaves it in debt", () => {
    // 1000 bytes per second is one byte per millisecond
    const { batcher } = createBatcher({ batch: { maxMessages: 1 }, bytesPerSecond: 1000 });
    const target = createTarget();
    batcher.attach(target);

    enqueueAll(batcher, [snapshot("snap-600", 600), snapshot("snap-2500", 2500), snapshot("snap-200", 200)]);

    vi.advanceTimersByTime(10_000);
    // A full batch goes at once. 600 leaves 400; 2500 waits for a full bucket of 1000 and leaves -1500; 200 waits
    // for 1700 more
    expect(target.frames).toEqual([
      { atMs: 0, ids: ["snap-600"] },
      { atMs: 600, ids: ["snap-2500"] },
      { atMs: 2300, ids: ["snap-200"] },
    ]);
  });

  it("sends a control message queued during a rate wait before the data that was waiting", () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 1 }, bytesPerSecond: 1000 });
    const target = createTarget();
    batcher.attach(target);
    enqueueAll(batcher, [snapshot("snap-1", 600), snapshot("snap-2", 600)]);
    vi.advanceTimersByTime(150);

    batcher.enqueue(status("bp-1"));

    vi.advanceTimersByTime(10_000);
    expect(target.frames.map((frame) => frame.ids)).toEqual([["snap-1"], ["bp-1"], ["snap-2"]]);
  });

  it("writes nothing to a closing socket, and keeps the messages for the next target", () => {
    const { batcher } = createBatcher();
    const closing = createTarget();
    const next = createTarget();
    closing.open = false;
    batcher.attach(closing);
    batcher.enqueue(status("bp-1"));
    vi.advanceTimersByTime(1000);
    batcher.detach();

    batcher.attach(next);

    vi.advanceTimersByTime(100);
    expect({ closing: closing.frames, next: next.frames }).toEqual({
      closing: [],
      next: [{ atMs: 1100, ids: ["bp-1"] }],
    });
  });

  it("writes to the next target after a detach while the socket was full, and only once", () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 1, maxBytes: 1000 } });
    const full = createTarget();
    const next = createTarget();
    batcher.attach(full);
    full.unsent = 1000;
    batcher.enqueue(status("bp-1"));
    vi.advanceTimersByTime(1000);
    batcher.detach();

    batcher.attach(next);

    vi.advanceTimersByTime(100);
    full.finishWrites();
    vi.advanceTimersByTime(1000);
    expect({ full: full.frames, next: next.frames }).toEqual({ full: [], next: [{ atMs: 1000, ids: ["bp-1"] }] });
  });

  it("writes nothing after detach()", () => {
    const { batcher } = createBatcher();
    const target = createTarget();
    batcher.attach(target);
    batcher.enqueue(status("bp-1"));

    batcher.detach();

    vi.advanceTimersByTime(1000);
    expect(target.frames).toEqual([]);
  });

  it("reports an error thrown by the socket instead of throwing from the timer", () => {
    const { batcher, internalErrors } = createBatcher();
    const failure = Object.assign(new Error("write failed"), { code: "ERR_TEST_WRITE" });
    batcher.attach({
      isOpen: () => true,
      unsentBytes: () => 0,
      write: () => {
        throw failure;
      },
    });
    batcher.enqueue(status("bp-1"));

    vi.advanceTimersByTime(100);

    expect(internalErrors).toEqual([failure]);
  });
});

describe("Batcher drain()", () => {
  it("writes everything queued at once, without waiting for the flush interval, and resolves", async () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 2 } });
    const target = createTarget();
    enqueueAll(batcher, [snapshot("bp-1"), status("bp-2"), status("bp-3")]);

    await batcher.drain(target);

    expect(target.frames).toEqual([
      { atMs: 0, ids: ["bp-2", "bp-3"] },
      { atMs: 0, ids: ["bp-1"] },
    ]);
  });

  it("keeps to the rate limit and resolves once the last batch is written", async () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 1 }, bytesPerSecond: 200 });
    const target = createTarget();
    enqueueAll(batcher, [snapshot("bp-1"), snapshot("bp-2")]);

    const drained = batcher.drain(target);
    await vi.advanceTimersByTimeAsync(1000);
    await drained;

    expect(target.frames).toEqual([
      { atMs: 0, ids: ["bp-1"] },
      { atMs: 1000, ids: ["bp-2"] },
    ]);
  });

  it("resolves without writing when the socket is not open", async () => {
    const { batcher } = createBatcher();
    const target = createTarget();
    target.open = false;
    batcher.enqueue(status("bp-1"));

    await batcher.drain(target);

    expect(target.frames).toEqual([]);
  });

  it("resolves when the socket closes while it waits for a write", async () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 1, maxBytes: 100 } });
    const target = createTarget();
    const write = target.write.bind(target);
    // Each frame fills the socket, so the next one waits for it to be written
    target.write = (text, onWritten) => {
      write(text, onWritten);
      target.unsent = 100;
    };
    enqueueAll(batcher, [status("bp-1"), status("bp-2")]);
    const drained = batcher.drain(target);

    target.open = false;
    target.finishWrites();
    await drained;

    expect({ frames: target.frames.map((frame) => frame.ids), left: batcher.discard() }).toEqual({
      frames: [["bp-1"]],
      left: 1,
    });
  });

  it("resolves and writes nothing more once detached while it waits for the rate limit", async () => {
    const { batcher } = createBatcher({ batch: { maxMessages: 1 }, bytesPerSecond: 200 });
    const target = createTarget();
    enqueueAll(batcher, [snapshot("bp-1"), snapshot("bp-2")]);
    const drained = batcher.drain(target);

    batcher.detach();
    await drained;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(target.frames.map((frame) => frame.ids)).toEqual([["bp-1"]]);
  });

  it("leaves what it could not send for discard() to count", async () => {
    const { batcher } = createBatcher();
    const target = createTarget();
    target.open = false;
    enqueueAll(batcher, [status("bp-1"), snapshot("bp-2")]);
    await batcher.drain(target);

    const dropped = batcher.discard();

    expect({ dropped, again: batcher.discard() }).toEqual({ dropped: 2, again: 0 });
  });
});
