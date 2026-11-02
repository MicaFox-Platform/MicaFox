import { PROTOCOL_VERSION, type Batch, type Message } from "@probex-platform/protocol";

/** A frame the connector logs and drops; `reason` is fixed text that never quotes the frame. */
export interface IgnoredFrame {
  kind: "ignored";
  level: "warn" | "debug";
  reason: string;
}

/** What a frame from the hub after `welcome` turned out to be. */
export type HubFrame =
  | { kind: "message"; message: Message }
  | IgnoredFrame
  /** A protocol error: the session ends with `protocolError`. */
  | { kind: "rejected"; reason: string };

type MessageType = Message["type"] | Batch["type"];

// Who sends each message type. A Record, so a new protocol type does not compile until it is listed here.
const SENDERS: Readonly<Record<MessageType, "hub" | "sdk">> = {
  hello: "sdk",
  welcome: "hub",
  breakpoints: "hub",
  breakpointStatus: "sdk",
  snapshot: "sdk",
  batch: "sdk",
};

/** Parses `text` as JSON; `undefined` when it is not valid JSON, which `JSON.parse` never returns otherwise. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Own keys only: a hub could send "toString" or "__proto__" as a type
const isKnownType = (type: string): type is MessageType => Object.hasOwn(SENDERS, type);

const UNTYPED_MESSAGE = "ignored a message from the hub without a numeric version and a string type";

const ignore = (level: IgnoredFrame["level"], reason: string): IgnoredFrame => ({ kind: "ignored", level, reason });

const readByType = (message: object, type: string): HubFrame => {
  // Newer hubs may send types this SDK does not know yet (docs/architecture/sdk/connector.md#receiving-a-message)
  if (!isKnownType(type)) {
    return ignore("debug", "ignored a message of an unknown type from the hub");
  }

  if (type === "welcome") {
    return ignore("debug", "ignored a welcome from the hub after the first one");
  }

  if (SENDERS[type] === "sdk") {
    return ignore("warn", `ignored a ${type} message from the hub; only the SDK sends it`);
  }

  // Only the type is checked here: interpreting the message, and checking its fields, is the debugger's job
  return { kind: "message", message: message as Message };
};

/**
 * Reads a frame from the hub after `welcome` (ADR 0016: every message has the session's version); `text` is
 * `undefined` for a binary frame.
 */
export const readHubFrame = (text: string | undefined): HubFrame => {
  if (text === undefined) {
    return ignore("warn", "ignored a binary frame from the hub");
  }

  const message = parseJson(text);
  if (message === undefined) {
    return ignore("warn", "ignored a frame from the hub that is not valid JSON");
  }

  if (typeof message !== "object" || message === null) {
    return ignore("warn", UNTYPED_MESSAGE);
  }

  const version: unknown = Reflect.get(message, "version");
  const type: unknown = Reflect.get(message, "type");
  if (typeof version !== "number" || typeof type !== "string") {
    return ignore("warn", UNTYPED_MESSAGE);
  }

  if (version !== PROTOCOL_VERSION) {
    const reason = `the hub sent a message of protocol version ${String(version)}; the session speaks ${String(PROTOCOL_VERSION)}`;
    return { kind: "rejected", reason };
  }

  return readByType(message, type);
};
