// Stands in for the debugger until it exists: the replies the debugger will send, made up instead of captured.

import { PROTOCOL_VERSION, type BreakpointStatus, type Message, type Snapshot } from "@micafox/protocol";

const readId = (entry: unknown): unknown =>
  typeof entry === "object" && entry !== null ? Reflect.get(entry, "id") : undefined;

/**
 * Returns one `active` status per breakpoint of a `breakpoints` message, and none for any other message. The message
 * comes from the network, so an entry without a string `id` gets no status, as docs/api/protocol.md#breakpoints says.
 */
export const toActiveStatuses = (message: Message): BreakpointStatus[] => {
  const entries: unknown = message.type === "breakpoints" ? message.breakpoints : undefined;
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.flatMap((entry: unknown): BreakpointStatus[] => {
    const breakpointId = readId(entry);
    return typeof breakpointId === "string"
      ? [{ version: PROTOCOL_VERSION, type: "breakpointStatus", breakpointId, status: "active" }]
      : [];
  });
};

/** Returns the snapshot `POST /demo/snapshot` sends, taken at `time` (milliseconds since the Unix epoch). */
export const createSampleSnapshot = (time: number): Snapshot => ({
  version: PROTOCOL_VERSION,
  type: "snapshot",
  breakpointId: "demo-snapshot",
  time,
  stack: [{ function: "sendSampleSnapshot", file: "src/index.ts", line: 1, column: 1 }],
  variables: [{ name: "orderId", value: { type: "string", value: "order-42", length: 8 } }],
});
