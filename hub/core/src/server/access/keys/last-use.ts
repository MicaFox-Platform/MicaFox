import { writeKeysLastUse } from "./queries.js";
import type { Database } from "../../db/index.js";

// Keys used since the last write; past this many the new ones wait for the next connection or ping after the write
const MAX_NOTED_KEYS = 10_000;

/** The last use of project keys, noted in memory as the SDK endpoint sees them and written every minute. */
export interface KeyUses {
  /** Notes that `keyId` is used now: O(1), no I/O. */
  note: (keyId: string) => void;
  /** Writes the noted uses; on failure they are kept for the next write. */
  write: () => Promise<void>;
}

/** What the key uses need. */
export interface KeyUsesOptions {
  db: Database;
  now: () => number;
}

export const createKeyUses = (options: KeyUsesOptions): KeyUses => {
  let noted = new Map<string, number>();

  return {
    note: (keyId) => {
      if (noted.size < MAX_NOTED_KEYS || noted.has(keyId)) {
        noted.set(keyId, options.now());
      }
    },
    write: async () => {
      if (noted.size === 0) {
        return;
      }
      const writing = noted;
      noted = new Map();
      try {
        await writeKeysLastUse(options.db.global, writing);
      } catch (error) {
        // A use noted since is newer than the one that failed to write
        for (const [keyId, usedAt] of writing) {
          if (!noted.has(keyId) && noted.size < MAX_NOTED_KEYS) {
            noted.set(keyId, usedAt);
          }
        }
        throw error;
      }
    },
  };
};
