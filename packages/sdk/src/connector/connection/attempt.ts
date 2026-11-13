import { CLOSE_CODES, type Hello, type Message } from "@micafox/protocol";
import { isIP, connect as netConnect, type Socket, type TcpNetConnectOpts } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { WebSocket, type ClientOptions, type RawData } from "ws";

import { describeClose, describeError, describeStatus, type AttemptFailure } from "./attempt-failure.js";
import { Heartbeat } from "./heartbeat.js";
import type { HubTarget } from "./hub-url.js";
import { readErrorCode } from "../../logger/index.js";
import {
  checkFirstFrame,
  readHubFrame,
  type HubFrame,
  type IgnoredFrame,
  type ModuleAgreement,
} from "../session/index.js";

/** What an attempt tells its connector. */
export interface AttemptEvents {
  /** The hub has accepted the session; `modules` says which of the `hello` modules it carries. */
  onWelcome(modules: ModuleAgreement): void;
  /** A message from the hub after `welcome`, of a type the hub sends. */
  onMessage(message: Message): void;
  /** A frame after `welcome` that is dropped; the connector logs it. */
  onIgnored(frame: IgnoredFrame): void;
  /** Called at most once, and never after `stop()`. */
  onEnd(failure: AttemptFailure): void;
}

/** What one attempt connects to and says first. */
export interface AttemptSettings {
  target: HubTarget;
  token: string | undefined;
  hello: Hello;
}

// The protocol's limits: docs/api/protocol.md#hello
const HANDSHAKE_TIMEOUT_MS = 10_000;
const WELCOME_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1_048_576;
// ws waits this long for the hub to finish a closing handshake before it destroys the socket; its timer is not
// unref'd, so this is how long a closing socket can hold the host process
const CLOSING_HANDSHAKE_TIMEOUT_MS = 1000;

// @types/ws 8.18 does not declare `closeTimeout`, which ws has had since 8.19
type SocketOptions = ClientOptions & { closeTimeout: number };

// What ws passes to `createConnection`: the request options, where `path` is the HTTP path
type ConnectOptions = TcpNetConnectOpts & ConnectionOptions & { path?: string };

// Replaces ws's own netConnect/tlsConnect so the socket is unref'd before it connects: the connector never keeps
// the host process alive. When the host resolves to several addresses, as localhost does, Node gives each next
// attempt a new handle that is ref'd again, so every attempt is unref'd too. `path` is dropped: net.connect would
// take it for a Unix socket.
const createUnrefConnection =
  (isSecure: boolean) =>
  (options: ConnectOptions): Socket => {
    const socket = isSecure
      ? tlsConnect({ ...options, path: undefined, servername: toServername(options.host) })
      : netConnect({ ...options, path: undefined });
    socket.unref();
    socket.on("connectionAttempt", () => {
      socket.unref();
    });
    return socket;
  };

// SNI takes a name only; an IP there makes Node print a deprecation warning to the host's stderr
const toServername = (host: string | undefined): string => (host === undefined || isIP(host) !== 0 ? "" : host);

const createSocketOptions = ({ target, token }: AttemptSettings): SocketOptions => ({
  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  perMessageDeflate: false,
  followRedirects: false,
  rejectUnauthorized: true,
  maxPayload: MAX_FRAME_BYTES,
  handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
  closeTimeout: CLOSING_HANDSHAKE_TIMEOUT_MS,
  // ws types this as net.createConnection with all its overloads; ws itself calls it with one options object
  createConnection: createUnrefConnection(target.isSecure) as ClientOptions["createConnection"],
});

// With ws's default binaryType every message is one Buffer
const toText = (data: RawData, isBinary: boolean): string | undefined =>
  isBinary || !Buffer.isBuffer(data) ? undefined : data.toString("utf8");

/** One connection to the hub: opens the socket, sends `hello`, waits for `welcome`, then receives and pings. */
export class Attempt {
  private readonly socket: WebSocket;
  private readonly heartbeat: Heartbeat;
  private hasEnded = false;
  // The modules the session carries; set by `welcome`
  private agreed: ReadonlySet<string> | undefined;
  private welcomeTimer: NodeJS.Timeout | undefined;

  /** Opens the socket; throws only when ws rejects the options, before any I/O. */
  constructor(
    private readonly settings: AttemptSettings,
    private readonly events: AttemptEvents,
  ) {
    this.socket = new WebSocket(settings.target.href, createSocketOptions(settings));
    this.heartbeat = new Heartbeat({
      ping: () => {
        this.guard(() => {
          this.socket.ping();
        });
      },
      onSilence: () => {
        this.guard(() => {
          this.onSilence();
        });
      },
    });
    // Each listener stays for the socket's whole life: ws can emit `error` a tick after terminate(), and an
    // `error` without a listener would crash the host app
    this.socket.on("error", (error) => {
      this.guard(() => {
        this.onError(error);
      });
    });
    this.socket.on("unexpected-response", (_request, response) => {
      this.guard(() => {
        this.onUnexpectedResponse(response.statusCode);
      });
    });
    this.socket.on("open", () => {
      this.guard(() => {
        this.onOpen();
      });
    });
    this.socket.on("message", (data, isBinary) => {
      this.guard(() => {
        this.onMessage(data, isBinary);
      });
    });
    // ws answers the hub's pings itself; either way a ping or pong shows the hub is alive
    for (const event of ["ping", "pong"] as const) {
      this.socket.on(event, () => {
        this.heartbeat.onActivity();
      });
    }
    this.socket.on("close", (code) => {
      this.guard(() => {
        this.end(describeClose(code));
      });
    });
  }

  /** Tells whether the socket is open; once the hub starts closing it, ws drops what it is handed. */
  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** Bytes handed to the socket and not written out yet. */
  unsentBytes(): number {
    return this.socket.bufferedAmount;
  }

  /**
   * Writes `text` as one frame; call it only after `welcome`, while `isOpen()`. `onWritten` runs once the socket has
   * written it or failed to. A frame on a socket that drops is lost: delivery is at most once (ADR 0007).
   */
  write(text: string, onWritten: () => void): void {
    this.socket.send(text, () => {
      onWritten();
    });
  }

  /** Stops the heartbeat, so a hub that goes quiet while `close()` flushes does not end the attempt. */
  stopPinging(): void {
    this.heartbeat.stop();
  }

  /**
   * Ends the attempt without reporting it: closes a welcomed socket with 1000; aborts one still connecting or not
   * welcomed yet, so nothing waits on a hub that has not accepted the session.
   */
  stop(): Promise<void> {
    this.hasEnded = true;
    this.clearTimers();
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }

    const closed = new Promise<void>((resolve) => {
      this.socket.once("close", () => {
        resolve();
      });
    });
    if (this.socket.readyState === WebSocket.OPEN && this.isWelcomed()) {
      this.socket.close(1000);
    } else if (this.socket.readyState !== WebSocket.CLOSING) {
      this.socket.terminate();
    }

    return closed;
  }

  // Socket and timer callbacks are a boundary: nothing thrown here may reach the host app. A failure ends the
  // attempt, since it may have left the welcome timer unarmed and the connector waiting forever.
  private guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.abandon(error);
    }
  }

  private abandon(error: unknown): void {
    try {
      this.end(describeError("error", "the connector hit an unexpected error", { key: "internal-error", error }));
      this.socket.terminate();
    } catch {
      // Already inside the boundary's last resort; there is nowhere safer to report a second failure
    }
  }

  private end(failure: AttemptFailure): void {
    if (this.hasEnded) {
      return;
    }

    this.hasEnded = true;
    this.clearTimers();
    this.events.onEnd(failure);
  }

  private isWelcomed(): boolean {
    return this.agreed !== undefined;
  }

  private clearTimers(): void {
    clearTimeout(this.welcomeTimer);
    this.heartbeat.stop();
  }

  private onError(error: Error): void {
    if (readErrorCode(error) === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
      const message = "the hub sent a frame over 1 MiB";
      this.end({ level: "error", message, key: "hub-frame-too-large", isRejection: true });
      return;
    }

    if (this.isWelcomed()) {
      this.end(describeError("warn", "the connection to the hub dropped", { key: "hub-dropped", error }));
      return;
    }

    const message = `could not connect to the hub at ${this.settings.target.description}`;
    this.end(describeError("warn", message, { key: "hub-unreachable", error }));
  }

  private onUnexpectedResponse(statusCode: number | undefined): void {
    this.end(describeStatus(statusCode));
    // With an `unexpected-response` listener ws leaves the request open; this aborts it
    this.socket.terminate();
  }

  private onOpen(): void {
    if (this.hasEnded) {
      return;
    }

    // The only frame before `welcome` (ADR 0009)
    this.socket.send(JSON.stringify(this.settings.hello));
    this.welcomeTimer = setTimeout(() => {
      this.guard(() => {
        this.end({
          level: "warn",
          message: "the hub sent no welcome within 10 s",
          key: "hub-no-welcome",
          isRejection: false,
        });
        this.socket.terminate();
      });
    }, WELCOME_TIMEOUT_MS);
    this.welcomeTimer.unref();
    this.heartbeat.start();
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.hasEnded) {
      return;
    }

    this.heartbeat.onActivity();
    const text = toText(data, isBinary);
    if (this.agreed !== undefined) {
      this.onHubFrame(readHubFrame(text, this.agreed));
      return;
    }

    const check = checkFirstFrame(text, this.settings.hello.modules);
    if (!check.ok) {
      this.rejectSession(check.reason);
      return;
    }

    this.agreed = check.agreed;
    clearTimeout(this.welcomeTimer);
    this.events.onWelcome({ agreed: check.agreed, refused: check.refused });
  }

  private onHubFrame(frame: HubFrame): void {
    switch (frame.kind) {
      case "message":
        this.events.onMessage(frame.message);
        return;
      case "ignored":
        this.events.onIgnored(frame);
        return;
      case "rejected":
        this.rejectSession(frame.reason);
        return;
    }
  }

  // A protocol error: the reason is fixed text, so each kind collapses on its own in the log
  private rejectSession(reason: string): void {
    this.end({ level: "error", message: reason, key: `hub-protocol-error:${reason}`, isRejection: true });
    // A closing handshake, not terminate(), so the hub receives the code
    this.socket.close(CLOSE_CODES.protocolError);
  }

  private onSilence(): void {
    this.end({
      level: "warn",
      message: "the hub answered no ping within 10 s",
      key: "hub-no-pong",
      isRejection: false,
    });
    // No closing handshake: a hub that answers nothing would not answer that either
    this.socket.terminate();
  }
}
