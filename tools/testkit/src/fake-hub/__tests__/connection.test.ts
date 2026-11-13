import { CLOSE_CODES } from "@micafox/protocol";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { onConnection } from "../connection.js";

// The transport is the boundary: a socket that keeps what the hub sends and how it closes
class FakeSocket extends EventEmitter {
  readonly sent: unknown[] = [];
  closeCode: number | undefined;

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  close(code: number): void {
    this.closeCode = code;
  }
}

const BREAKPOINT = { id: "bp-quote", file: "src/pricing.ts", line: 33, expiresInMs: 60_000 };

const connect = (): FakeSocket => {
  const socket = new FakeSocket();
  onConnection(socket as unknown as WebSocket, () => [BREAKPOINT]);
  return socket;
};

const helloWith = (fields: Record<string, unknown>): Buffer =>
  Buffer.from(JSON.stringify({ version: 1, type: "hello", instanceId: "i-1", ...fields }));

describe("onConnection", () => {
  // The hub prints every message to stdout, which the tests read in a real process; here it would only add noise
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("welcomes a hello that lists the debugger with it, then sends the tagged breakpoints", () => {
    const socket = connect();

    socket.emit("message", helloWith({ modules: ["debugger", "errors"] }), false);

    expect(socket.sent).toEqual([
      { version: 1, type: "welcome", modules: ["debugger"] },
      { version: 1, module: "debugger", type: "breakpoints", breakpoints: [BREAKPOINT] },
    ]);
  });

  it("welcomes a hello without a modules array with no modules and sends no breakpoints", () => {
    const socket = connect();

    socket.emit("message", helloWith({}), false);

    expect(socket.sent).toEqual([{ version: 1, type: "welcome", modules: [] }]);
  });

  it("closes with incompatibleVersion when the hello has another version", () => {
    const socket = connect();

    socket.emit("message", helloWith({ version: 2, modules: ["debugger"] }), false);

    expect({ sent: socket.sent, closeCode: socket.closeCode }).toEqual({
      sent: [],
      closeCode: CLOSE_CODES.incompatibleVersion,
    });
  });
});
