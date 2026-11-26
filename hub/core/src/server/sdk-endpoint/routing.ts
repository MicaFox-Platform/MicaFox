import type { WebSocket } from "@fastify/websocket";
import { CLOSE_CODES } from "@micafox/protocol";
import type { Batch, Message } from "@micafox/protocol";

import type { FrameData } from "./handshake.js";
import { createRateLimit } from "./liveness.js";
import { CLOSE } from "./sessions.js";
import type { Connection, SdkSessions } from "./sessions.js";
import type { ProtocolModule, SdkSession } from "../feature/index.js";

/** A frame is nested at most this deep, the frame itself being level 1: a batch holds its messages at level 3. */
const MAX_DEPTH = 64;

// Postgres cannot store NUL in text; a lone surrogate is not text at all. NUL comes in as a variable, which the
// control-character rule cannot see, so the pattern is not spelt with a control character
const NUL = String.fromCharCode(0);
const UNSTORABLE = new RegExp(
  `${NUL}|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]`,
  "g",
);
const REPLACEMENT = "\uFFFD";

// Fails on bytes that are not UTF-8, where `toString` would turn them into U+FFFD unnoticed
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** What the endpoint counts: what it drops or repairs, for the metrics to report. */
export type SdkCountName = "sanitized" | "rate-limited" | "handler-failed";

/** How often each thing was counted since the hub started. */
export interface SdkCounts {
  add: (name: SdkCountName, amount?: number) => void;
  list: () => Array<{ name: SdkCountName; count: number }>;
}

/** Counts in memory; at most one entry per name. */
export const createSdkCounts = (): SdkCounts => {
  const counts = new Map<SdkCountName, number>();
  return {
    add: (name, amount = 1) => {
      counts.set(name, (counts.get(name) ?? 0) + amount);
    },
    list: () => [...counts].map(([name, count]) => ({ name, count })),
  };
};

/** What a frame is: the messages in it, in order, or why the session closes. */
export type ParsedFrame = { messages: Message[]; sanitized: number } | { reason: string };

type Json = Record<string, unknown> | unknown[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasUnstorable = (text: string): boolean => {
  UNSTORABLE.lastIndex = 0;
  return UNSTORABLE.test(text);
};

// One pass over every value, with a stack instead of recursion since the depth is what is being checked; it never
// allocates more than the stack. Gives the depth, and whether some string or key holds what Postgres cannot store.
const measure = (root: Json): { depth: number; hasUnstorable: boolean } => {
  let depth = 0;
  let found = false;
  const stack: Array<{ value: unknown; level: number }> = [{ value: root, level: 1 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, level } = item;
    if (typeof value === "string") {
      found ||= hasUnstorable(value);
    } else if (typeof value === "object" && value !== null) {
      depth = Math.max(depth, level);
      if (depth > MAX_DEPTH) {
        return { depth, hasUnstorable: found };
      }
      for (const [key, child] of Object.entries(value)) {
        found ||= !Array.isArray(value) && hasUnstorable(key);
        stack.push({ value: child, level: level + 1 });
      }
    }
  }
  return { depth, hasUnstorable: found };
};

// Rebuilds `value` with U+FFFD for what Postgres cannot store, and counts each one; recursion is safe, as `measure`
// has bounded the depth. Two keys that become the same keep the later value.
const scrub = (value: unknown, counter: { replaced: number }): unknown => {
  const replace = (text: string): string =>
    text.replace(UNSTORABLE, () => {
      counter.replaced += 1;
      return REPLACEMENT;
    });
  if (typeof value === "string") {
    return replace(value);
  }
  if (Array.isArray(value)) {
    return value.map((child: unknown) => scrub(child, counter));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [replace(key), scrub(child, counter)]));
  }
  return value;
};

const decode = (data: FrameData): string => {
  if (Array.isArray(data)) {
    return strictUtf8.decode(Buffer.concat(data));
  }
  return strictUtf8.decode(Buffer.isBuffer(data) ? data : new Uint8Array(data));
};

// A message has the session's version and a string `type`; whatever else it must hold is its feature's to check
const hasVersionAndType = (value: unknown, version: number): value is Message | Batch =>
  isRecord(value) && value.version === version && typeof value.type === "string";

// A batch never holds a batch
const isMessage = (value: unknown, version: number): value is Message =>
  hasVersionAndType(value, version) && value.type !== "batch";

const messagesOf = (frame: unknown, version: number): Message[] | undefined => {
  if (!hasVersionAndType(frame, version)) {
    return undefined;
  }
  if (frame.type !== "batch") {
    return [frame];
  }
  const { messages } = frame;
  return Array.isArray(messages) && messages.every((message) => isMessage(message, version)) ? messages : undefined;
};

/**
 * Reads a frame the SDK sent: UTF-8 JSON of a message or a `batch` of messages in the session's version, at most
 * 64 levels deep. NUL characters and unpaired surrogates in its strings and keys become U+FFFD; how many is in
 * `sanitized`. A frame that is anything else gives the reason the session closes.
 */
export const parseFrame = (data: FrameData, isBinary: boolean, version: number): ParsedFrame => {
  if (isBinary) {
    return { reason: "binary frame" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(data));
  } catch {
    // Not UTF-8, not JSON, or nested so deep that V8 refuses to parse it
    return { reason: "not UTF-8 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { reason: "not a message" };
  }
  const measured = measure(parsed as Json);
  if (measured.depth > MAX_DEPTH) {
    return { reason: "nested too deep" };
  }
  const counter = { replaced: 0 };
  const clean = measured.hasUnstorable ? scrub(parsed, counter) : parsed;
  const messages = messagesOf(clean, version);
  return messages === undefined
    ? { reason: "not a message of this version" }
    : { messages, sanitized: counter.replaced };
};

/** What routing needs from the endpoint. */
export interface RoutingOptions {
  sessions: SdkSessions;
  /** The module of each feature the hub runs, by name. */
  modules: ReadonlyMap<string, ProtocolModule>;
  counts: SdkCounts;
  maxMessagesPerSecond: number;
  now: () => number;
  warnCollapsed: (key: string, fields: Record<string, unknown>, message: string) => void;
}

interface Route {
  connection: Connection;
  session: SdkSession;
  version: number;
  options: RoutingOptions;
  isWithinRate: () => boolean;
}

// A repeated hello is ignored; a message of no module, of a module the session did not agree on or no feature
// serves, is ignored too. Only the first of them is worth a warning: the SDK always tags its messages.
const moduleOf = (route: Route, message: Message): ProtocolModule | undefined => {
  const { connection, options } = route;
  if (message.type === "hello") {
    return undefined;
  }
  const { module } = message as { module?: unknown };
  if (typeof module !== "string") {
    options.warnCollapsed(
      `sdk.message-without-module:${connection.key.prefix}`,
      { keyPrefix: connection.key.prefix, type: message.type },
      "sdk.message-without-module",
    );
    return undefined;
  }
  return connection.modules.has(module) ? options.modules.get(module) : undefined;
};

const handOver = async (route: Route, module: ProtocolModule, message: Message): Promise<void> => {
  const { options, connection } = route;
  try {
    await module.onMessage(route.session, message);
  } catch (error) {
    options.counts.add("handler-failed");
    options.warnCollapsed(
      `sdk.handler-failed:${module.module}`,
      { err: error, module: module.module, type: message.type, instanceId: route.session.instanceId },
      "sdk.handler-failed",
    );
    connection.log.debug({ err: error, module: module.module }, "sdk.handler-failed");
  }
};

// One message: dropped over the rate, ignored when no feature is to see it, else handed to its feature
const routeMessage = async (route: Route, message: Message): Promise<void> => {
  const { options, connection } = route;
  if (!route.isWithinRate()) {
    options.counts.add("rate-limited");
    options.warnCollapsed(
      `sdk.rate-limited:${connection.key.prefix}`,
      { keyPrefix: connection.key.prefix, limit: options.maxMessagesPerSecond },
      "sdk.rate-limited",
    );
    return;
  }
  const module = moduleOf(route, message);
  if (module !== undefined) {
    await handOver(route, module, message);
  }
};

// A frame: its messages in order, until the session closes
const routeFrame = async (route: Route, data: FrameData, isBinary: boolean): Promise<void> => {
  const { connection, options } = route;
  const frame = parseFrame(data, isBinary, route.version);
  if ("reason" in frame) {
    options.warnCollapsed(
      `sdk.protocol-error:${connection.key.prefix}`,
      { keyPrefix: connection.key.prefix, environmentId: connection.key.environmentId, reason: frame.reason },
      "sdk.protocol-error",
    );
    options.sessions.close(connection, CLOSE_CODES.protocolError);
    return;
  }
  if (frame.sanitized > 0) {
    options.counts.add("sanitized", frame.sanitized);
  }
  for (const message of frame.messages) {
    if (options.sessions.isClosing(connection)) {
      return;
    }
    await routeMessage(route, message);
  }
};

/**
 * Routes the frames of a welcomed session to the features, one frame after another: a slow `onMessage` makes the
 * socket stop reading, so the frames wait in the kernel and the SDK's own buffer. The hub keeps only the frames one
 * read of the socket completed: that read, about 64 KiB, and at most one frame of `MICAFOX_SDK_MAX_FRAME_BYTES`.
 */
export const startRouting = (connection: Connection, socket: WebSocket, options: RoutingOptions): void => {
  const { session, version } = connection;
  if (session === undefined || version === undefined) {
    return;
  }
  const rate = createRateLimit({ perSecond: options.maxMessagesPerSecond, now: options.now });
  const route: Route = { connection, session, version, options, isWithinRate: rate.take };
  const waiting: Array<{ data: FrameData; isBinary: boolean }> = [];
  let isRunning = false;

  // A failure here is the hub's, never the SDK's: the session closes with 1011, and the socket is read again so the
  // close can complete
  const drain = async (): Promise<void> => {
    isRunning = true;
    try {
      // `waiting` holds the frames one read of the socket completed, no more, so `shift` is cheap
      for (let next = waiting.shift(); next !== undefined; next = waiting.shift()) {
        if (options.sessions.isClosing(connection)) {
          break;
        }
        await routeFrame(route, next.data, next.isBinary);
      }
    } catch (error) {
      connection.log.error({ err: error }, "sdk.routing-failed");
      options.sessions.close(connection, CLOSE.internalError);
    } finally {
      waiting.length = 0;
      isRunning = false;
      socket.resume();
    }
  };

  socket.on("message", (data: FrameData, isBinary: boolean) => {
    waiting.push({ data, isBinary });
    if (!isRunning) {
      socket.pause();
      void drain();
    }
  });
};
