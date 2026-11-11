import { CLOSE_CODES } from "@micafox/protocol";

import { readErrorCode } from "../../logger/index.js";

/** Why an attempt ended; `message` never holds the token, the URL's userinfo or query, or text from the hub. */
export interface AttemptFailure {
  level: "warn" | "error";
  message: string;
  /** Names the problem, so the logger collapses repeats. */
  key: string;
  /** The hub refused the session: the next wait is the longest one. */
  isRejection: boolean;
}

// Only the code: an error's message can quote the URL or a response header. The code is part of the key too, so a
// changed cause, such as a rotated certificate during an outage, is logged in full instead of as a repeat.
export const describeError = (
  level: AttemptFailure["level"],
  message: string,
  { key, error }: { key: string; error: unknown },
): AttemptFailure => {
  const code = readErrorCode(error) ?? "";
  const text = code === "" ? message : `${message} (${code})`;
  return { level, message: text, key: `${key}:${code}`, isRejection: false };
};

export const describeClose = (code: number): AttemptFailure => {
  if (code === CLOSE_CODES.incompatibleVersion) {
    const message = "the hub does not support this SDK's protocol version (close code 4426)";
    return { level: "error", message, key: "hub-incompatible-version", isRejection: true };
  }

  if (code === CLOSE_CODES.protocolError) {
    const message = "the hub closed the session with a protocol error (close code 4400)";
    return { level: "error", message, key: "hub-protocol-error", isRejection: true };
  }

  // The close reason is the hub's text and is never logged
  const message = `the connection to the hub closed (close code ${String(code)})`;
  return { level: "warn", message, key: `hub-closed:${String(code)}`, isRejection: false };
};

export const describeStatus = (statusCode: number | undefined): AttemptFailure => {
  const status = String(statusCode);
  if (statusCode === 401 || statusCode === 403) {
    const message = `the hub rejected the token (HTTP ${status}); check MICAFOX_TOKEN`;
    return { level: "error", message, key: "hub-unauthorized", isRejection: true };
  }

  // A redirect is not followed: its Location, like every response header, is never logged
  const message = `the hub answered the WebSocket upgrade with HTTP ${status}`;
  return { level: "warn", message, key: `hub-unexpected-response:${status}`, isRejection: false };
};
