import type { Message } from "./v1.js";

export type * from "./v1.js";

/** The protocol version this package describes; every message carries it in `version`. */
export const PROTOCOL_VERSION = 1;

/** WebSocket close codes a hub uses to end a session. */
export const CLOSE_CODES = {
  protocolError: 4400,
  incompatibleVersion: 4426,
} as const;

/** The connection state a `Connector` reports to its status handlers. */
export type ConnectorStatus = "connecting" | "connected" | "disconnected" | "closed";

/** Carries protocol messages between the SDK and a hub. */
export interface Connector {
  connect(): void;
  send(message: Message): void;
  onMessage(handler: (message: Message) => void): () => void;
  onStatus(handler: (status: ConnectorStatus) => void): () => void;
  close(): Promise<void>;
}
