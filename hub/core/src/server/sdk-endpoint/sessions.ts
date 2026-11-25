import type { WebSocket } from "@fastify/websocket";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";

import type { KeyScope } from "../access/index.js";
import type { Timers } from "../observability/index.js";

/** WebSocket close codes the hub sends besides the protocol's own `CLOSE_CODES`. */
export const CLOSE = { goingAway: 1001, policyViolation: 1008, internalError: 1011 } as const;

// A peer that does not answer a close within this time is cut off, so it holds no slot and no stop waits on it.
// ws would wait 30 s for the closing handshake.
const CLOSE_GRACE_MS = 2000;

/** One SDK connection, from the key check before the upgrade until its socket closes. */
export interface Connection {
  readonly key: KeyScope;
  /** The connection's logger, with the key's prefix and ids and, after `hello`, the instance. */
  readonly log: Logger;
  /** Settles when the TCP socket closes, whether it was upgraded or not. */
  readonly closed: Promise<void>;
  /** When the connection last received anything, a ping included; for the idle check. */
  readonly lastActivityMs: number;
}

interface Entry extends Connection {
  log: Logger;
  lastActivityMs: number;
  readonly raw: Duplex;
  socket: WebSocket | undefined;
  instanceId: string | undefined;
  /** Set once the hub has decided to close it; a connection not yet upgraded closes with it when it is. */
  closeCode: number | undefined;
  graceTimer: NodeJS.Timeout | undefined;
}

/** What the sessions need from the hub. */
export interface SessionsOptions {
  timers: Timers;
  now: () => number;
}

/**
 * The open SDK connections of this replica: counted from the key check, so the limits never overshoot, and kept by
 * environment and `instanceId` once their `hello` is accepted: docs/architecture/hub/sdk-endpoint.md.
 */
export class SdkSessions {
  private readonly entries = new Set<Entry>();
  private readonly byKey = new Map<string, Set<Entry>>();
  // `<environmentId> <instanceId>`: ids are UUIDs and `instanceId` is checked, so no space can blur the two
  private readonly byInstance = new Map<string, Entry>();

  constructor(private readonly options: SessionsOptions) {}

  /** Every connection now, upgraded or not. */
  get size(): number {
    return this.entries.size;
  }

  /** The connections of a key now. */
  countOfKey(keyId: string): number {
    return this.byKey.get(keyId)?.size ?? 0;
  }

  /** Every connection now, for the idle check. */
  list(): Iterable<Connection> {
    return this.entries;
  }

  /** Counts a connection from its key check; it is forgotten when `raw` closes, however it ends. */
  reserve(key: KeyScope, raw: Duplex, log: Logger): Connection {
    // A client may hang up while its key is looked up; its socket is gone before the reservation is made
    const closed = raw.destroyed ? Promise.resolve() : new Promise<void>((resolve) => raw.once("close", resolve));
    const entry: Entry = {
      key,
      log,
      closed,
      raw,
      lastActivityMs: this.options.now(),
      socket: undefined,
      instanceId: undefined,
      closeCode: undefined,
      graceTimer: undefined,
    };
    this.entries.add(entry);
    const ofKey = this.byKey.get(key.keyId) ?? new Set<Entry>();
    ofKey.add(entry);
    this.byKey.set(key.keyId, ofKey);
    void closed.then(() => {
      this.release(entry);
    });
    return entry;
  }

  /** Gives the connection its WebSocket; a connection the hub closed meanwhile closes now with that code. */
  attach(connection: Connection, socket: WebSocket): void {
    const entry = this.entryOf(connection);
    entry.socket = socket;
    if (entry.closeCode !== undefined) {
      socket.close(entry.closeCode);
    }
  }

  /** Whether the hub has decided to close the connection, or it has closed. */
  isClosing(connection: Connection): boolean {
    const entry = this.entryOf(connection);
    return entry.closeCode !== undefined || !this.entries.has(entry);
  }

  /**
   * Makes the connection the session of `instanceId` in its environment; an open session of the same instance there
   * closes with 1001. Answers false, and keeps nothing, when the connection is closing.
   */
  register(connection: Connection, instanceId: string): boolean {
    const entry = this.entryOf(connection);
    if (this.isClosing(entry)) {
      return false;
    }
    const slot = `${entry.key.environmentId} ${instanceId}`;
    const previous = this.byInstance.get(slot);
    if (previous !== undefined) {
      this.close(previous, CLOSE.goingAway);
    }
    entry.instanceId = instanceId;
    entry.log = entry.log.child({ instanceId });
    this.byInstance.set(slot, entry);
    return true;
  }

  /** Notes that the connection received something now. */
  touch(connection: Connection): void {
    this.entryOf(connection).lastActivityMs = this.options.now();
  }

  /** Closes the connection with `code`; a peer that does not close within 2 s is cut off. */
  close(connection: Connection, code: number): void {
    const entry = this.entryOf(connection);
    if (entry.closeCode !== undefined || !this.entries.has(entry)) {
      return;
    }
    entry.closeCode = code;
    entry.socket?.close(code);
    entry.graceTimer = this.options.timers.setTimeout(() => {
      entry.raw.destroy();
    }, CLOSE_GRACE_MS);
  }

  /** Cuts the connection off at once, without a close frame: for a peer that went silent. */
  terminate(connection: Connection): void {
    this.entryOf(connection).raw.destroy();
  }

  /** Closes every connection of a key, as when it is revoked. */
  closeKey(keyId: string, code: number): void {
    for (const entry of this.byKey.get(keyId) ?? []) {
      this.close(entry, code);
    }
  }

  /** Closes every connection of an organization, as when its entitlements change. O(connections); it is rare. */
  closeOrg(orgId: string, code: number): void {
    for (const entry of this.entries) {
      if (entry.key.orgId === orgId) {
        this.close(entry, code);
      }
    }
  }

  /** Closes every connection and settles once all have closed, at most 2 s later. */
  async closeAll(code: number): Promise<void> {
    const closing = [...this.entries];
    for (const entry of closing) {
      this.close(entry, code);
    }
    await Promise.all(
      closing.map(async (entry) => {
        await entry.closed;
      }),
    );
  }

  private release(entry: Entry): void {
    this.entries.delete(entry);
    if (entry.graceTimer !== undefined) {
      this.options.timers.clearTimeout(entry.graceTimer);
    }
    const ofKey = this.byKey.get(entry.key.keyId);
    ofKey?.delete(entry);
    if (ofKey?.size === 0) {
      this.byKey.delete(entry.key.keyId);
    }
    const slot = `${entry.key.environmentId} ${entry.instanceId ?? ""}`;
    // A session that was replaced must not remove its replacement
    if (entry.instanceId !== undefined && this.byInstance.get(slot) === entry) {
      this.byInstance.delete(slot);
    }
  }

  // Connections are only ever made by `reserve`, so every one is an entry
  private entryOf(connection: Connection): Entry {
    return connection as Entry;
  }
}
