import type { WebSocket } from "@fastify/websocket";
import { CLOSE_CODES } from "@micafox/protocol";
import type { Hello, Welcome } from "@micafox/protocol";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Compile } from "typebox/compile";

import { CLOSE } from "./sessions.js";
import type { Connection, SdkSessions } from "./sessions.js";
import type { Gate } from "../feature/index.js";
import type { Timers } from "../observability/index.js";

/** The hub closes a connection that has not got its `welcome` this long after it opened. */
const HELLO_TIMEOUT_MS = 10_000;

// The protocol versions the hub has types for: ADR 0016
const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([1]);

const nameAndVersion = Type.Object({ name: Type.String(), version: Type.String() });

// The structure of a v1 `hello` only: a newer v1 SDK may add optional fields, which pass, and fields that are too
// long are cut where they are stored, never a reason to refuse the session
const helloSchema = Type.Object({
  version: Type.Literal(1),
  type: Type.Literal("hello"),
  instanceId: Type.String({ minLength: 1, maxLength: 64 }),
  service: Type.Optional(Type.String()),
  labels: Type.Record(Type.String(), Type.String()),
  hostname: Type.String(),
  pid: Type.Number(),
  sdk: nameAndVersion,
  runtime: nameAndVersion,
  modules: Type.Array(Type.String()),
  commit: Type.Optional(Type.String()),
});

const helloValidator = Compile(helloSchema);

// Fails to compile when the schema lets through what is not a `Hello`, so the two cannot drift apart
const toHello = (value: Static<typeof helloSchema>): Hello => value;

/** What the first frame is: a `hello`, or why the connection closes. */
export type FirstFrame = { hello: Hello } | { closeCode: number; reason: string };

/** The data of a received frame, as `ws` hands it over. */
export type FrameData = Buffer | ArrayBuffer | Buffer[];

const textOf = (data: FrameData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const protocolError = (reason: string): FirstFrame => ({ closeCode: CLOSE_CODES.protocolError, reason });

/** Reads the first frame of a connection: it must be a text frame with a valid `hello` of a known version. */
export const readFirstFrame = (data: FrameData, isBinary: boolean): FirstFrame => {
  if (isBinary) {
    return protocolError("binary frame");
  }
  const message = parseJson(textOf(data));
  if (!isRecord(message) || message.type !== "hello") {
    return protocolError("first frame is not a hello");
  }
  if (typeof message.version !== "number") {
    return protocolError("hello without a version");
  }
  if (!SUPPORTED_VERSIONS.has(message.version)) {
    return { closeCode: CLOSE_CODES.incompatibleVersion, reason: "unknown version" };
  }
  if (!helloValidator.Check(message)) {
    return protocolError("invalid hello");
  }
  return { hello: toHello(message) };
};

/**
 * The modules of `hello` the session agrees on: those a registered feature serves and the organization may use.
 * Repeated names count once. Throws when the gate cannot answer.
 */
export const agreeModules = async (modules: readonly string[], orgId: string, gate: Gate): Promise<string[]> => {
  const names = [...new Set(modules)];
  const allowed = await Promise.all(names.map(async (module) => await gate.isModuleEntitled(orgId, module)));
  return names.filter((_module, index) => allowed[index] === true);
};

/** What the handshake needs from the endpoint. */
export interface HandshakeOptions {
  sessions: SdkSessions;
  gate: Gate;
  timers: Timers;
  warnCollapsed: (key: string, fields: Record<string, unknown>, message: string) => void;
  /** Called once `welcome` is sent, with the modules it lists: routing and state start from here. */
  onWelcomed: (connection: Connection, modules: readonly string[]) => void;
}

const welcomeOf = (hello: Hello, modules: string[]): Welcome => ({ version: hello.version, type: "welcome", modules });

// Agrees on the modules, registers the session and answers `welcome`; the connection may close at any await
const acceptHello = async (
  connection: Connection,
  socket: WebSocket,
  parts: HandshakeOptions & { hello: Hello },
): Promise<boolean> => {
  const { hello, sessions } = parts;
  let modules: string[];
  try {
    modules = await agreeModules(hello.modules, connection.key.orgId, parts.gate);
  } catch (error) {
    connection.log.warn({ err: error }, "sdk.entitlements-failed");
    sessions.close(connection, CLOSE.internalError);
    return false;
  }
  if (!sessions.register(connection, { instanceId: hello.instanceId, modules, version: hello.version })) {
    return false;
  }
  socket.send(JSON.stringify(welcomeOf(hello, modules)));
  connection.log.info({ modules, version: hello.version }, "sdk.connected");
  parts.onWelcomed(connection, modules);
  return true;
};

/**
 * Runs the handshake of a new connection: its first frame must be a valid `hello`, answered with `welcome` within
 * 10 s of the upgrade. Later frames are routed from `onWelcomed`.
 */
export const startHandshake = (connection: Connection, socket: WebSocket, options: HandshakeOptions): void => {
  const { sessions, timers } = options;
  let hasHello = false;
  const timer = timers.setTimeout(() => {
    // No hello is the SDK's fault; a hello still waiting for its modules is the hub's
    sessions.close(connection, hasHello ? CLOSE.internalError : CLOSE_CODES.protocolError);
  }, HELLO_TIMEOUT_MS);
  void connection.closed.then(() => {
    timers.clearTimeout(timer);
  });

  socket.once("message", (data: FrameData, isBinary: boolean) => {
    hasHello = true;
    const frame = readFirstFrame(data, isBinary);
    if ("closeCode" in frame) {
      options.warnCollapsed(
        `sdk.protocol-error:${connection.key.prefix}`,
        { keyPrefix: connection.key.prefix, environmentId: connection.key.environmentId, reason: frame.reason },
        "sdk.protocol-error",
      );
      sessions.close(connection, frame.closeCode);
      return;
    }
    void acceptHello(connection, socket, { ...options, hello: frame.hello }).then((isAccepted) => {
      if (isAccepted) {
        timers.clearTimeout(timer);
      }
    });
  });
};
