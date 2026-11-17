import { PROTOCOL_VERSION, type Batch, type Hello, type Message, type Welcome } from "@micafox/protocol";

import { findModuleTypes } from "./modules.js";

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

// The session frames: no module may use these types (ADR 0017). Who sends them; a Record, so a new session frame
// does not compile until it is listed here.
const SESSION_FRAMES: Readonly<Record<Hello["type"] | Welcome["type"] | Batch["type"], "hub" | "sdk">> = {
  hello: "sdk",
  welcome: "hub",
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
const isSessionFrame = (type: string): type is keyof typeof SESSION_FRAMES => Object.hasOwn(SESSION_FRAMES, type);

const UNTYPED_MESSAGE = "ignored a message from the hub without a numeric version and a string type";

const ignore = (level: IgnoredFrame["level"], reason: string): IgnoredFrame => ({ kind: "ignored", level, reason });

const readSessionFrame = (type: keyof typeof SESSION_FRAMES): IgnoredFrame => {
  if (type === "welcome") {
    return ignore("debug", "ignored a welcome from the hub after the first one");
  }

  return ignore("warn", `ignored a ${type} message from the hub; only the SDK sends it`);
};

// Newer hubs may send modules and types this SDK does not know yet; they are ignored at debug so older SDKs keep
// working (docs/architecture/sdk/connector.md#receiving-a-message)
const readModuleMessage = (message: object, type: string, agreed: ReadonlySet<string>): HubFrame => {
  const module: unknown = Reflect.get(message, "module");
  if (typeof module !== "string") {
    return ignore("warn", "ignored a message from the hub without a string module");
  }

  if (!agreed.has(module)) {
    return ignore("debug", "ignored a message of a module the session did not agree on");
  }

  const types = findModuleTypes(module);
  if (types === undefined) {
    return ignore("debug", "ignored a message of a module the SDK does not know");
  }

  if (types.fromSdk.has(type)) {
    return ignore("warn", `ignored a ${type} message from the hub; only the SDK sends it`);
  }

  if (!types.fromHub.has(type)) {
    return ignore("debug", "ignored a message of an unknown type from the hub");
  }

  // Only the module and the type are checked here: interpreting the message, and checking its fields, is the module's job
  return { kind: "message", message: message as Message };
};

/**
 * Reads a frame from the hub after `welcome` (ADR 0016: every message has the session's version) in the order of
 * `Message`: session frame, then `module`, then `type`. Only the `agreed` modules reach the handlers (ADR 0017);
 * `text` is `undefined` for a binary frame.
 */
export const readHubFrame = (text: string | undefined, agreed: ReadonlySet<string>): HubFrame => {
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

  return isSessionFrame(type) ? readSessionFrame(type) : readModuleMessage(message, type, agreed);
};
