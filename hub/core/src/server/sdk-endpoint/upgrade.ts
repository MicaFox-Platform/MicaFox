import type { KeyScope } from "../access/index.js";
import { hashToken } from "../access/index.js";
import type { ProblemName } from "../app/index.js";

// A key found is kept this long, so a reconnect storm needs no database and keys in the cache still connect while
// Postgres is down; a revoke drops it at once
const KEY_TTL_MS = 60_000;
// The oldest entry is dropped past this many keys or revoked keys
const MAX_CACHED_KEYS = 10_000;

// `mfx_pk_` and the base64url of 32 random bytes: ADR 0030. Anything else is refused without asking the database.
const KEY_FORMAT = /^mfx_pk_[\w-]{43}$/;
const BEARER = /^bearer\s+(\S+)\s*$/i;

interface Cached {
  key: KeyScope;
  expiresAt: number;
}

const putBounded = <T>(map: Map<string, T>, id: string, value: T): void => {
  map.delete(id);
  if (map.size >= MAX_CACHED_KEYS) {
    const oldest = map.keys().next();
    if (oldest.done !== true) {
      map.delete(oldest.value);
    }
  }
  map.set(id, value);
};

/**
 * The keys found by their hash, for 60 s, and the keys revoked in the last 60 s: a lookup that started before a
 * revoke and ends after it must neither cache the key nor let it connect.
 */
export class KeyCache {
  private readonly keys = new Map<string, Cached>();
  private readonly hashByKeyId = new Map<string, string>();
  private readonly revoked = new Map<string, number>();
  // Lookups running now by token hash: connections that arrive together, as after a restart, share one query
  private readonly lookups = new Map<string, Promise<KeyScope | undefined>>();

  constructor(private readonly now: () => number) {}

  /** The cached key of `tokenHash`, while it is fresh. */
  find(tokenHash: string): KeyScope | undefined {
    const cached = this.keys.get(tokenHash);
    if (cached === undefined || cached.expiresAt <= this.now()) {
      return undefined;
    }
    return cached.key;
  }

  /** Keeps a key the database found, unless it was revoked meanwhile. */
  remember(tokenHash: string, key: KeyScope): void {
    if (this.isRevoked(key.keyId)) {
      return;
    }
    putBounded(this.keys, tokenHash, { key, expiresAt: this.now() + KEY_TTL_MS });
    putBounded(this.hashByKeyId, key.keyId, tokenHash);
  }

  /** Drops a revoked key and refuses it for the next 60 s, whatever a running lookup finds. */
  revoke(keyId: string): void {
    const tokenHash = this.hashByKeyId.get(keyId);
    if (tokenHash !== undefined) {
      this.keys.delete(tokenHash);
      this.hashByKeyId.delete(keyId);
    }
    putBounded(this.revoked, keyId, this.now() + KEY_TTL_MS);
  }

  /**
   * The answer of `lookup` for `tokenHash`, shared by every caller until it settles. At most one lookup per distinct
   * token runs, and a settled one is forgotten at once, so the map holds only what is running.
   */
  lookup(tokenHash: string, lookup: () => Promise<KeyScope | undefined>): Promise<KeyScope | undefined> {
    const running = this.lookups.get(tokenHash);
    if (running !== undefined) {
      return running;
    }
    const started = lookup().finally(() => {
      this.lookups.delete(tokenHash);
    });
    this.lookups.set(tokenHash, started);
    return started;
  }

  /** Whether the key was revoked in the last 60 s. */
  isRevoked(keyId: string): boolean {
    const until = this.revoked.get(keyId);
    return until !== undefined && until > this.now();
  }
}

/** Why a connection is refused before the upgrade: the problem and its detail. */
export interface Refusal {
  problem: ProblemName;
  detail: string;
}

/** The key check's answer: the key to connect with, or the refusal. */
export type UpgradeDecision = { key: KeyScope } | { refusal: Refusal };

/** What the key check needs. */
export interface UpgradeCheckOptions {
  cache: KeyCache;
  lookupKey: (token: string) => Promise<KeyScope | undefined>;
  /** The connections now, in total and of a key. */
  counts: { total: () => number; ofKey: (keyId: string) => number };
  limits: { maxConnections: number; maxConnectionsPerKey: number };
}

const refuse = (problem: ProblemName, detail: string): UpgradeDecision => ({ refusal: { problem, detail } });

// The key of a well-formed token: from the cache, else from the database; `undefined` when it is unknown or revoked
const findKey = async (token: string, options: UpgradeCheckOptions): Promise<KeyScope | undefined> => {
  const tokenHash = hashToken(token);
  const cached = options.cache.find(tokenHash);
  if (cached !== undefined) {
    return cached;
  }
  const found = await options.cache.lookup(tokenHash, async () => await options.lookupKey(token));
  if (found === undefined || options.cache.isRevoked(found.keyId)) {
    return undefined;
  }
  options.cache.remember(tokenHash, found);
  return found;
};

/**
 * Finds the key of a `GET /sdk`: a well-formed bearer token of an active key. A replica at its most connections is
 * refused before the lookup; `checkLimits` checks again once the key is known. Throws when the key is not cached and
 * the database cannot answer.
 */
export const checkUpgrade = async (
  authorization: string | undefined,
  options: UpgradeCheckOptions,
): Promise<UpgradeDecision> => {
  const token = BEARER.exec(authorization ?? "")?.[1];
  if (token === undefined) {
    return refuse("unauthenticated", "A project key is required as a bearer token");
  }
  if (!KEY_FORMAT.test(token)) {
    return refuse("forbidden", "The project key is unknown or revoked");
  }
  if (options.counts.total() >= options.limits.maxConnections) {
    return refuse("rate-limited", "The hub has its most SDK connections");
  }
  const key = await findKey(token, options);
  return key === undefined ? refuse("forbidden", "The project key is unknown or revoked") : { key };
};

/**
 * Whether one more connection of `key` stays within the limits of the replica and of the key. The caller reserves
 * the connection in the same synchronous step, so connections whose lookups ran at once cannot all get through.
 */
export const checkLimits = (
  key: KeyScope,
  options: Pick<UpgradeCheckOptions, "counts" | "limits">,
): Refusal | undefined => {
  if (options.counts.total() >= options.limits.maxConnections) {
    return { problem: "rate-limited", detail: "The hub has its most SDK connections" };
  }
  if (options.counts.ofKey(key.keyId) >= options.limits.maxConnectionsPerKey) {
    return { problem: "rate-limited", detail: "The project key has its most SDK connections" };
  }
  return undefined;
};
