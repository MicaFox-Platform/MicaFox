import type { WebSocket } from "@fastify/websocket";
import { CLOSE_CODES } from "@micafox/protocol";
import type { Message } from "@micafox/protocol";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { recordingModule } from "../../../../test/sdk-endpoint/recording-module.js";
import type { RecordingBehavior } from "../../../../test/sdk-endpoint/recording-module.js";
import { createManualClock } from "../../../../test/server/manual-clock.js";
import { startRouting, createSdkCounts } from "../routing.js";
import { SdkSessions } from "../sessions.js";

const KEY = {
  keyId: "key-1",
  prefix: "mfx_pk_abcde",
  orgId: "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01",
  projectId: "project-1",
  environmentId: "production",
};
const INSTANCE = "8f14e45f-ceea-467f-a0e6-3b5c2a1d9e7b";

const statusOf = (breakpointId: string): Message => ({
  version: 1,
  module: "debugger",
  type: "breakpointStatus",
  breakpointId,
  status: "active",
});
const frameOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

// The part of a WebSocket that routing uses: frames in, pause and resume, and the close the sessions send
class FakeSocket extends EventEmitter {
  closeCodes: number[] = [];
  pauses = 0;
  resumes = 0;
  pause(): void {
    this.pauses += 1;
  }
  resume(): void {
    this.resumes += 1;
    this.emit("resumed");
  }
  close(code: number): void {
    this.closeCodes.push(code);
  }
  receive(data: Buffer, isBinary = false): void {
    this.emit("message", data, isBinary);
  }
}

// A welcomed session of the `debugger` module, routed to `module`
const setup = (
  behavior: RecordingBehavior = {},
  options: { maxMessagesPerSecond?: number; agreed?: string[]; warnFails?: boolean } = {},
) => {
  const manual = createManualClock();
  const sessions = new SdkSessions({ timers: manual.clock, now: manual.clock.now });
  const connection = sessions.reserve(KEY, new PassThrough(), pino({ enabled: false }));
  const socket = new FakeSocket();
  sessions.attach(connection, socket as unknown as WebSocket);
  sessions.register(connection, { instanceId: INSTANCE, modules: options.agreed ?? ["debugger"], version: 1 });
  const module = recordingModule("debugger", behavior);
  const counts = createSdkCounts();
  const warnings: string[] = [];
  startRouting(connection, socket as unknown as WebSocket, {
    sessions,
    modules: new Map([["debugger", module]]),
    counts,
    maxMessagesPerSecond: options.maxMessagesPerSecond ?? 1000,
    now: manual.clock.now,
    warnCollapsed: (key) => {
      if (options.warnFails === true) {
        throw new Error("the log is gone");
      }
      warnings.push(key);
    },
  });
  return { manual, socket, module, counts, warnings, sessions, connection };
};

// A promise a test settles when it decides, to hold `onMessage`
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

describe("routing a message", () => {
  it("hands a message to its feature with the session", async () => {
    const { socket, module } = setup();

    socket.receive(frameOf(statusOf("b1.1")));
    await module.delivered(1);

    expect(module.received).toEqual([
      {
        session: { orgId: KEY.orgId, projectId: "project-1", environmentId: "production", instanceId: INSTANCE },
        message: statusOf("b1.1"),
      },
    ]);
  });

  it("hands over the messages of a batch in order, each after the one before it settled", async () => {
    const first = gate();
    const { socket, module } = setup({
      onMessage: async (_session, message) => {
        if ("breakpointId" in message && message.breakpointId === "b1.1") {
          await first.wait;
        }
      },
    });

    socket.receive(frameOf({ version: 1, type: "batch", messages: [statusOf("b1.1"), statusOf("b2.1")] }));
    await module.delivered(1);
    const whileHeld = module.received.length;
    first.open();
    await module.delivered(2);

    expect([whileHeld, module.received.map(({ message }) => message)]).toEqual([
      1,
      [statusOf("b1.1"), statusOf("b2.1")],
    ]);
  });

  it("keeps frames in order when a feature is slow, and stops the socket reading meanwhile", async () => {
    const first = gate();
    const { socket, module } = setup({
      onMessage: async (_session, message) => {
        if ("breakpointId" in message && message.breakpointId === "b1.1") {
          await first.wait;
        }
      },
    });

    socket.receive(frameOf(statusOf("b1.1")));
    socket.receive(frameOf(statusOf("b2.1")));
    await module.delivered(1);
    const whileHeld = { handled: module.received.length, pauses: socket.pauses, resumes: socket.resumes };
    first.open();
    await module.delivered(2);

    expect([whileHeld, module.received.map(({ message }) => message)]).toEqual([
      { handled: 1, pauses: 1, resumes: 0 },
      [statusOf("b1.1"), statusOf("b2.1")],
    ]);
  });

  it("reads the socket again once the frames that waited are handled", async () => {
    const { socket, module } = setup();

    const resumed = once(socket, "resumed");
    socket.receive(frameOf(statusOf("b1.1")));
    await resumed;

    expect([module.received.length, socket.pauses, socket.resumes]).toEqual([1, 1, 1]);
  });
});

describe("routing a frame that is not valid", () => {
  it.each([
    ["is not JSON", Buffer.from("{nope"), false],
    ["is binary", frameOf(statusOf("b1.1")), true],
    ["has another version", frameOf({ ...statusOf("b1.1"), version: 2 }), false],
  ])("closes the session with protocolError when a frame %s", (_name, data, isBinary) => {
    const { socket, warnings } = setup();

    socket.receive(data, isBinary);

    expect([socket.closeCodes, warnings]).toEqual([[CLOSE_CODES.protocolError], [`sdk.protocol-error:${KEY.prefix}`]]);
  });

  it("hands nothing over from the frames that wait behind the one that closed the session", async () => {
    const { socket, module, sessions, connection } = setup();

    const resumed = once(socket, "resumed");
    socket.receive(Buffer.from("{nope"));
    socket.receive(frameOf(statusOf("b1.1")));
    await resumed;

    expect([module.received, sessions.isClosing(connection)]).toEqual([[], true]);
  });
});

describe("routing a message that no feature is to see", () => {
  it("ignores a repeated hello, and keeps the session", async () => {
    const { socket, module, warnings } = setup();
    const hello = { version: 1, type: "hello", instanceId: INSTANCE, modules: ["debugger"] };

    socket.receive(frameOf({ version: 1, type: "batch", messages: [hello, statusOf("b1.1")] }));
    await module.delivered(1);

    expect([module.received.map(({ message }) => message), socket.closeCodes, warnings]).toEqual([
      [statusOf("b1.1")],
      [],
      [],
    ]);
  });

  it("ignores a message without a module, with a collapsed warning", async () => {
    const { socket, module, warnings } = setup();

    socket.receive(
      frameOf({ version: 1, type: "batch", messages: [{ version: 1, type: "snapshot" }, statusOf("b1.1")] }),
    );
    await module.delivered(1);

    expect([module.received.map(({ message }) => message), warnings]).toEqual([
      [statusOf("b1.1")],
      [`sdk.message-without-module:${KEY.prefix}`],
    ]);
  });

  it("ignores a message whose module is not a string", async () => {
    const { socket, module, warnings } = setup();

    socket.receive(
      frameOf({ version: 1, type: "batch", messages: [{ version: 1, type: "x", module: 7 }, statusOf("b1.1")] }),
    );
    await module.delivered(1);

    expect(warnings).toEqual([`sdk.message-without-module:${KEY.prefix}`]);
  });

  it("ignores a message of a module the session did not agree on, though a feature serves it", async () => {
    const { socket, module } = setup({}, { agreed: ["profiler"] });

    const resumed = once(socket, "resumed");
    socket.receive(frameOf(statusOf("b1.1")));
    await resumed;

    expect(module.received).toEqual([]);
  });

  it("ignores a message of a module no feature serves", async () => {
    const { socket, module } = setup({}, { agreed: ["debugger", "unknown"] });

    socket.receive(
      frameOf({
        version: 1,
        type: "batch",
        messages: [{ version: 1, module: "unknown", type: "x" }, statusOf("b1.1")],
      }),
    );
    await module.delivered(1);

    expect(module.received.map(({ message }) => message)).toEqual([statusOf("b1.1")]);
  });
});

describe("routing a flood", () => {
  it("drops the messages over MICAFOX_SDK_MAX_MESSAGES_PER_SECOND over 10 s, counts them and warns once collapsed", async () => {
    const { socket, module, counts, warnings } = setup({}, { maxMessagesPerSecond: 1 });
    const messages = Array.from({ length: 13 }, (_, index) => statusOf(`b${String(index)}.1`));

    const handled = once(socket, "resumed");
    socket.receive(frameOf({ version: 1, type: "batch", messages }));
    await handled;

    expect([module.received.length, counts.list(), warnings]).toEqual([
      10,
      [{ name: "rate-limited", count: 3 }],
      Array(3).fill(`sdk.rate-limited:${KEY.prefix}`),
    ]);
  });

  it("takes messages again as the rate refills, and the session stays open", async () => {
    const { socket, module, manual } = setup({}, { maxMessagesPerSecond: 1 });
    const messages = Array.from({ length: 11 }, (_, index) => statusOf(`b${String(index)}.1`));
    const handled = once(socket, "resumed");
    socket.receive(frameOf({ version: 1, type: "batch", messages }));
    await handled;

    manual.advance(1000);
    socket.receive(frameOf(statusOf("later.1")));
    await module.delivered(11);

    expect([module.received.at(-1)?.message, socket.closeCodes]).toEqual([statusOf("later.1"), []]);
  });
});

describe("routing to a feature that fails", () => {
  it("logs and counts an onMessage that throws, and the session stays", async () => {
    const { socket, module, counts, warnings } = setup({
      onMessage: async (_session, message) => {
        await Promise.resolve();
        if ("breakpointId" in message && message.breakpointId === "bad.1") {
          throw new Error("the database is gone");
        }
      },
    });

    socket.receive(frameOf({ version: 1, type: "batch", messages: [statusOf("bad.1"), statusOf("b2.1")] }));
    await module.delivered(2);

    expect([counts.list(), warnings, socket.closeCodes]).toEqual([
      [{ name: "handler-failed", count: 1 }],
      ["sdk.handler-failed:debugger"],
      [],
    ]);
  });
});

describe("routing counts what it repairs", () => {
  it("counts the characters it replaced, and hands over the repaired message", async () => {
    const { socket, module, counts } = setup();

    socket.receive(Buffer.from('{"version":1,"module":"debugger","type":"x","note":"a\\u0000\\ud800"}'));
    await module.delivered(1);

    expect([counts.list(), module.received[0]?.message]).toEqual([
      [{ name: "sanitized", count: 2 }],
      { version: 1, module: "debugger", type: "x", note: "a��" },
    ]);
  });
});

describe("routing when the hub itself fails", () => {
  it("closes the session with 1011 and reads the socket again, without an unhandled rejection", async () => {
    const { socket, sessions, connection } = setup({}, { warnFails: true });
    const resumed = once(socket, "resumed");

    socket.receive(frameOf({ version: 1, type: "snapshot" }));
    await resumed;

    expect([socket.closeCodes, socket.resumes, sessions.isClosing(connection)]).toEqual([[1011], 1, true]);
  });

  it("hands over nothing from the frames that waited behind the one that failed", async () => {
    const { socket, module } = setup({}, { warnFails: true });
    const resumed = once(socket, "resumed");

    socket.receive(frameOf({ version: 1, type: "snapshot" }));
    socket.receive(frameOf(statusOf("b1.1")));
    await resumed;

    expect(module.received).toEqual([]);
  });
});
