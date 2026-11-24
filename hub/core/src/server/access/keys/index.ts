import { findKeyByHash } from "./queries.js";
import type { KeyScope } from "./queries.js";
import type { Database } from "../../db/index.js";
import { hashToken } from "../tokens/index.js";

export { addKeyRoutes } from "./key-routes.js";
export { createRevokeHooks } from "./revoke-hooks.js";
export type { KeyRevokedListener } from "./revoke-hooks.js";
export type { KeyScope } from "./queries.js";

/** Finds the active project key `token` is by the SHA-256 of it; a revoked or unknown token gives `undefined`. */
export const createKeyLookup =
  (db: Database): ((token: string) => Promise<KeyScope | undefined>) =>
  async (token) =>
    await findKeyByHash(db.global, hashToken(token));
