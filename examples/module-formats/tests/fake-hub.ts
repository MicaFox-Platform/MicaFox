// The hub side of docs/api/protocol.md#hello, cut down to what tests/ need: it answers a hello with welcome and the
// breakpoints of HUB_BREAKPOINTS, prints every message it receives as one JSON line, the messages of a batch one by
// one, and prints `disconnected` once an app's connection closes, after its last message. PORT=0 picks a free port.

import { PROTOCOL_VERSION } from "@micafox/protocol";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const readField = (message: unknown, field: string): unknown =>
  typeof message === "object" && message !== null ? Reflect.get(message, field) : undefined;

const parseFrame = (data: RawData, isBinary: boolean): unknown => {
  if (isBinary || !Buffer.isBuffer(data)) {
    return undefined;
  }

  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    return undefined;
  }
};

const unwrapBatch = (message: unknown): unknown[] => {
  const messages = readField(message, "type") === "batch" ? readField(message, "messages") : undefined;
  return Array.isArray(messages) ? messages : [message];
};

const onConnection = (socket: WebSocket, breakpoints: unknown): void => {
  let isWelcomed = false;
  socket.on("message", (data, isBinary) => {
    const frame = parseFrame(data, isBinary);
    for (const message of unwrapBatch(frame)) {
      print(JSON.stringify(message));
    }

    if (!isWelcomed && readField(frame, "type") === "hello") {
      isWelcomed = true;
      socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: "welcome" }));
      socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: "breakpoints", breakpoints }));
    }
  });
  // `close` comes after the last `message` of the socket
  socket.on("close", () => {
    print("disconnected");
  });
  socket.on("error", () => {
    // The app went away mid-frame; `close` follows
  });
};

const main = (): void => {
  const breakpoints: unknown = JSON.parse(process.env.HUB_BREAKPOINTS ?? "[]");
  const server = createServer();
  const hub = new WebSocketServer({ server });
  hub.on("connection", (socket) => {
    onConnection(socket, breakpoints);
  });
  server.listen(Number(process.env.PORT ?? "0"), "127.0.0.1", () => {
    // listen() with a port and a host always gives an AddressInfo
    print(`listening on port ${String((server.address() as AddressInfo).port)}`);
  });
};

try {
  main();
} catch (error) {
  console.error("fake hub failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
