// A hub for the connector's tests: a real `ws` server on 127.0.0.1:0, over plain TCP or TLS with the test-only
// self-signed certificate in fixtures/. Each upgrade is answered as `reply` says, so a test can play an accepting,
// rejecting or misbehaving hub. useFakeHubs() also fails a test that leaves an uncaught exception or an unhandled
// rejection behind, which is how the SDK would crash its host app.

import { PROTOCOL_VERSION } from "@micafox/protocol";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
/** The test-only self-signed certificate the TLS hub serves. */
export const CERT_FILE = path.join(FIXTURES, "cert.pem");
const KEY_FILE = path.join(FIXTURES, "key.pem");
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** How the hub answers an upgrade request. */
export type UpgradeReply =
  | { kind: "accept" }
  | { kind: "status"; status: number; headers?: Readonly<Record<string, string>> }
  /** No answer at all: the upgrade request stays open until the connector gives up on it. */
  | { kind: "silent" }
  /** A valid 101 with extra headers, written by hand: `ws` itself would never send them. */
  | { kind: "acceptWithHeaders"; headers: Readonly<Record<string, string>> };

/** One WebSocket the hub accepted. */
export interface HubConnection {
  readonly request: IncomingMessage;
  readonly socket: WebSocket;
  /** Text of every frame received so far. */
  readonly frames: readonly string[];
  nextFrame(): Promise<string>;
  /** Resolves with the close code once the connection has closed. */
  readonly closed: Promise<number>;
  sendWelcome(version?: number): void;
}

/** A running fake hub. */
export interface FakeHub {
  /** `ws://` or `wss://` with host 127.0.0.1 and path `/micafox`. */
  readonly url: string;
  readonly port: number;
  /** Every upgrade request so far. */
  readonly requests: readonly IncomingMessage[];
  /** Answers the next upgrades; accepts by default. */
  reply: UpgradeReply;
  nextRequest(): Promise<IncomingMessage>;
  nextConnection(): Promise<HubConnection>;
  /** Resolves when the connector has ended the TCP connection of the next upgrade answered with `silent`. */
  nextSilentUpgradeEnded(): Promise<void>;
}

/** Options of a fake hub. */
export interface FakeHubOptions {
  isSecure?: boolean;
  /** Whether the hub answers pings by itself, as `ws` does by default. */
  autoPong?: boolean;
}

// Hands out items in arrival order, to whoever asks first
class Arrivals<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.items.push(item);
    } else {
      waiter(item);
    }
  }

  next(): Promise<T> {
    if (this.items.length > 0) {
      // Checked just above
      return Promise.resolve(this.items.shift() as T);
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

const createConnection = (socket: WebSocket, request: IncomingMessage): HubConnection => {
  const frames: string[] = [];
  const arrivals = new Arrivals<string>();
  socket.on("message", (data, isBinary) => {
    const text = isBinary || !Buffer.isBuffer(data) ? "<binary>" : data.toString("utf8");
    frames.push(text);
    arrivals.push(text);
  });
  socket.on("error", () => {
    // A connector that goes away mid-frame; the test asserts on what the connector did
  });
  const closed = new Promise<number>((resolve) => {
    socket.on("close", (code) => {
      resolve(code);
    });
  });
  return {
    request,
    socket,
    frames,
    nextFrame: () => arrivals.next(),
    closed,
    sendWelcome: (version = PROTOCOL_VERSION) => {
      socket.send(JSON.stringify({ version, type: "welcome", modules: ["debugger"] }));
    },
  };
};

const writeHead = (socket: Socket, statusLine: string, headers: Readonly<Record<string, string>>): void => {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  socket.write([statusLine, ...lines, "", ""].join("\r\n"));
};

const acceptKey = (request: IncomingMessage): string =>
  createHash("sha1")
    .update(`${String(request.headers["sec-websocket-key"])}${WEBSOCKET_GUID}`)
    .digest("base64");

const createServer = (isSecure: boolean): Server =>
  isSecure ? createHttpsServer({ cert: readFileSync(CERT_FILE), key: readFileSync(KEY_FILE) }) : createHttpServer();

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      // Listening on a TCP port, so the address is an AddressInfo
      resolve((server.address() as AddressInfo).port);
    });
  });

interface Upgrade {
  reply: UpgradeReply;
  request: IncomingMessage;
  socket: Socket;
  head: Buffer;
}

interface UpgradeOutcomes {
  onConnection: (connection: HubConnection) => void;
  onSilent: () => void;
}

const answerUpgrade = (
  { reply, request, socket, head }: Upgrade,
  wss: WebSocketServer,
  { onConnection, onSilent }: UpgradeOutcomes,
): void => {
  if (reply.kind === "silent") {
    onSilent();
    return;
  }

  if (reply.kind === "status") {
    writeHead(socket, `HTTP/1.1 ${String(reply.status)} Hub`, { ...reply.headers, "Content-Length": "0" });
    socket.end();
    return;
  }

  if (reply.kind === "acceptWithHeaders") {
    writeHead(socket, "HTTP/1.1 101 Switching Protocols", {
      upgrade: "websocket",
      connection: "Upgrade",
      "Sec-WebSocket-Accept": acceptKey(request),
      ...reply.headers,
    });
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    onConnection(createConnection(ws, request));
  });
};

interface RunningHub {
  hub: FakeHub;
  close(): Promise<void>;
}

// Ends every connection first: server.close() waits for open ones, and a connector's socket may still be open
const closeServer = (server: Server, wss: WebSocketServer, sockets: ReadonlySet<Socket>): Promise<void> =>
  new Promise((resolve) => {
    for (const client of wss.clients) {
      client.terminate();
    }

    for (const socket of sockets) {
      socket.destroy();
    }

    server.close(() => {
      resolve();
    });
  });

const startHub = async ({ isSecure = false, autoPong = true }: FakeHubOptions): Promise<RunningHub> => {
  const server = createServer(isSecure);
  const wss = new WebSocketServer({ noServer: true, autoPong });
  const sockets = new Set<Socket>();
  const requests: IncomingMessage[] = [];
  const requestArrivals = new Arrivals<IncomingMessage>();
  const connectionArrivals = new Arrivals<HubConnection>();
  const silentSockets = new Arrivals<Socket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {
    // The connector refusing the self-signed certificate
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => {
      // The connector aborting its handshake
    });
    requests.push(request);
    requestArrivals.push(request);
    answerUpgrade({ reply: hub.reply, request, socket, head }, wss, {
      onConnection: (connection) => {
        connectionArrivals.push(connection);
      },
      onSilent: () => {
        silentSockets.push(socket);
      },
    });
  });

  const port = await listen(server);
  const hub: FakeHub = {
    url: `${isSecure ? "wss" : "ws"}://127.0.0.1:${String(port)}/micafox`,
    port,
    requests,
    reply: { kind: "accept" },
    nextRequest: () => requestArrivals.next(),
    nextConnection: () => connectionArrivals.next(),
    nextSilentUpgradeEnded: async () => {
      const socket = await silentSockets.next();
      // The server's side stays half-open after the connector's FIN, so `end`, not `close`, marks it
      if (!socket.readableEnded) {
        socket.resume();
        await once(socket, "end");
      }
    },
  };

  const close = (): Promise<void> => closeServer(server, wss, sockets);
  return { hub, close };
};

/** Something a test opened that must be closed after it, such as a connector. */
export interface Closable {
  close(): Promise<void>;
}

/** What useFakeHubs() gives each test. */
export interface FakeHubs {
  start(options?: FakeHubOptions): Promise<FakeHub>;
  /** Closes `closable` after the test, before the hubs, and returns it. */
  track<T extends Closable>(closable: T): T;
}

const waitForImmediate = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Registers the hooks of a test file that uses fake hubs: closes what each test opened, then fails the test if an
 * uncaught exception or an unhandled rejection happened during it.
 */
export const useFakeHubs = (): FakeHubs => {
  let running: RunningHub[] = [];
  let closables: Closable[] = [];
  let escaped: unknown[] = [];
  const onEscaped = (error: unknown): void => {
    escaped.push(error);
  };

  beforeEach(() => {
    running = [];
    closables = [];
    escaped = [];
    process.on("uncaughtException", onEscaped);
    process.on("unhandledRejection", onEscaped);
  });

  afterEach(async () => {
    await Promise.all(closables.map((closable) => closable.close()));
    await Promise.all(running.map((started) => started.close()));
    // ws emits errors from process.nextTick: let them land in this test, not the next one
    await waitForImmediate();
    process.off("uncaughtException", onEscaped);
    process.off("unhandledRejection", onEscaped);

    expect(escaped, "an error escaped to the process").toEqual([]);
  });

  return {
    start: async (options = {}) => {
      const started = await startHub(options);
      running.push(started);
      return started.hub;
    },
    track: (closable) => {
      closables.push(closable);
      return closable;
    },
  };
};

/** A local port nothing listens on, so a connection to it is refused at once. */
export const findClosedPort = async (): Promise<number> => {
  const server = createHttpServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
};
