// One app's connection to the fake hub: every message it receives becomes one JSON line on stdout, the messages of a
// batch one by one, and `disconnected` follows the connection's last message.

import { CLOSE_CODES, PROTOCOL_VERSION } from "@micafox/protocol";
import type { RawData, WebSocket } from "ws";

/** Prints one line of the hub's output, which tests read line by line. */
export const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

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

const readField = (message: unknown, field: string): unknown =>
  typeof message === "object" && message !== null ? Reflect.get(message, field) : undefined;

const unwrapBatch = (message: unknown): unknown[] => {
  const messages = readField(message, "type") === "batch" ? readField(message, "messages") : undefined;
  return Array.isArray(messages) ? messages : [message];
};

// Answers the first hello: welcome in the hello's version, then the full breakpoint state
const answerHello = (socket: WebSocket, hello: unknown, breakpoints: unknown[]): void => {
  const version = readField(hello, "version");
  if (version !== PROTOCOL_VERSION) {
    socket.close(CLOSE_CODES.incompatibleVersion);
    return;
  }

  socket.send(JSON.stringify({ version, type: "welcome" }));
  socket.send(JSON.stringify({ version, type: "breakpoints", breakpoints }));
};

/** Serves one app: prints what it sends and answers its hello with welcome and `breakpoints`. */
export const onConnection = (socket: WebSocket, breakpoints: unknown[]): void => {
  let isWelcomed = false;
  socket.on("message", (data, isBinary) => {
    const frame = parseFrame(data, isBinary);
    if (frame === undefined) {
      print("ignored a frame that is not JSON text");
      return;
    }

    for (const message of unwrapBatch(frame)) {
      print(JSON.stringify(message));
    }

    if (!isWelcomed && readField(frame, "type") === "hello") {
      isWelcomed = true;
      answerHello(socket, frame, breakpoints);
    }
  });
  // `close` comes after the last `message` of the socket
  socket.on("close", () => {
    print("disconnected");
  });
  socket.on("error", () => {
    // The app went away mid-frame; `close` follows and it reconnects by itself
  });
};
