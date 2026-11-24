import type { FastifyBaseLogger } from "fastify";

import type { KeyScope } from "./queries.js";

/** What runs after a key is revoked, such as the SDK endpoint closing its sessions. */
export type KeyRevokedListener = (key: KeyScope) => void | Promise<void>;

/** The revoke hooks: listeners are added at start-up and run in the order added. */
export interface RevokeHooks {
  add: (listener: KeyRevokedListener) => void;
  /** Runs every listener once the revoke is committed; one that fails is logged and the rest still run. */
  run: (key: KeyScope, log: FastifyBaseLogger) => Promise<void>;
}

export const createRevokeHooks = (): RevokeHooks => {
  const listeners: KeyRevokedListener[] = [];
  return {
    add: (listener) => {
      listeners.push(listener);
    },
    run: async (key, log) => {
      for (const listener of listeners) {
        try {
          await listener(key);
        } catch (error) {
          log.error({ err: error, keyId: key.keyId, environmentId: key.environmentId }, "A key revoke hook failed");
        }
      }
    },
  };
};
