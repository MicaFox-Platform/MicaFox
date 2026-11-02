// A fake hub to try the app with and to test it end to end: it plays the hub side of docs/api/protocol.md#hello.
// It answers a hello with welcome and the breakpoints of HUB_BREAKPOINTS, and prints every message it receives as one
// JSON line, the messages of a batch one by one. Set HUB_TOKEN to accept only `Authorization: Bearer <HUB_TOKEN>`;
// PORT=0 picks a free port. It never prints headers or the token.

import { CLOSE_CODES, PROTOCOL_VERSION, type Breakpoint } from "@probex-platform/protocol";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

const DEFAULT_PORT = 8787;
// Only reported back as active by the app's stand-in for the debugger, which does not set them
const SAMPLE_BREAKPOINTS: Breakpoint[] = [
  { id: "bp-checkout", file: "src/orders/checkout.ts", line: 42 },
  { id: "bp-refund", file: "src/orders/refund.ts", line: 17 },
];

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const readPort = (): number => {
  const port = process.env.PORT ?? "";
  return port === "" ? DEFAULT_PORT : Number(port);
};

const readBreakpoints = (): unknown[] => {
  const json = process.env.HUB_BREAKPOINTS ?? "";
  if (json === "") {
    return SAMPLE_BREAKPOINTS;
  }

  const breakpoints: unknown = JSON.parse(json);
  if (!Array.isArray(breakpoints)) {
    throw new TypeError("HUB_BREAKPOINTS must be a JSON array of breakpoints");
  }

  return breakpoints;
};

const isAuthorized = (request: IncomingMessage, token: string): boolean =>
  token === "" || request.headers.authorization === `Bearer ${token}`;

const rejectUpgrade = (socket: Socket): void => {
  socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  print("rejected upgrade: 401");
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

const onConnection = (socket: WebSocket, breakpoints: unknown[]): void => {
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
  socket.on("error", () => {
    // The app went away mid-frame; it reconnects by itself
  });
};

const main = (): void => {
  const token = process.env.HUB_TOKEN ?? "";
  const breakpoints = readBreakpoints();
  const server = createServer();
  const hub = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket: Socket, head) => {
    socket.on("error", () => {
      // The app closed the connection before the upgrade was answered
    });
    if (!isAuthorized(request, token)) {
      rejectUpgrade(socket);
      return;
    }

    hub.handleUpgrade(request, socket, head, (webSocket) => {
      onConnection(webSocket, breakpoints);
    });
  });
  server.on("error", (error) => {
    console.error("fake hub failed:", error.message);
    process.exitCode = 1;
  });
  server.listen(readPort(), "127.0.0.1", () => {
    // listen() with a port and a host always gives an AddressInfo
    print(`listening on port ${String((server.address() as AddressInfo).port)}`);
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      // close() would wait for the open connections, which the app keeps open
      for (const client of hub.clients) {
        client.terminate();
      }
      hub.close();
      server.close();
    });
  }
};

try {
  main();
} catch (error) {
  console.error("fake hub failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
