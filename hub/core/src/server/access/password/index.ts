import { createConcurrencyLimit } from "./limit.js";
import { decoyHash, hashWithScrypt, isWeakerThanCurrent, matchesScrypt } from "./scrypt.js";

const MAX_CONCURRENT_HASHES = 4;
const MAX_WAITING_HASHES = 256;

/** The result of checking a password. */
export interface PasswordCheck {
  matches: boolean;
  /** The stored hash is weaker than a new one: replace it with `hash()` while the password is at hand. */
  needsRehash: boolean;
}

/** Hashes and checks passwords with scrypt, at most 4 at once. */
export interface PasswordHasher {
  hash: (password: string) => Promise<string>;
  /** Checks against `stored`, or against a decoy when there is none, which takes as long and never matches. */
  check: (password: string, stored: string | undefined) => Promise<PasswordCheck>;
}

/** Builds the hasher; its limit is shared by everything that calls it. */
export const createPasswordHasher = (): PasswordHasher => {
  const limit = createConcurrencyLimit(MAX_CONCURRENT_HASHES, MAX_WAITING_HASHES);
  return {
    hash: async (password) => await limit.run(async () => await hashWithScrypt(password)),
    check: async (password, stored) =>
      await limit.run(async () => {
        const matches = await matchesScrypt(password, stored ?? decoyHash());
        const isReal = stored !== undefined;
        return { matches: isReal && matches, needsRehash: isReal && isWeakerThanCurrent(stored) };
      }),
  };
};
