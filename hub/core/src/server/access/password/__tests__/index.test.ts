import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createPasswordHasher } from "../index.js";

// A hash made as an older hub would have, with weaker parameters
const weakHash = (password: string): string => {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, 32, { cost: 2 ** 14, blockSize: 8, parallelization: 1 });
  return ["scrypt", "16384", "8", "1", salt.toString("base64url"), key.toString("base64url")].join("$");
};

describe("createPasswordHasher", () => {
  it("makes a hash with N = 2^15, r = 8 and p = 3 that matches its password only", async () => {
    const passwords = createPasswordHasher();
    const hash = await passwords.hash("correct horse battery");

    const [right, wrong] = await Promise.all([
      passwords.check("correct horse battery", hash),
      passwords.check("Correct horse battery", hash),
    ]);

    expect([hash.startsWith("scrypt$32768$8$3$"), right, wrong]).toEqual([
      true,
      { matches: true, needsRehash: false },
      { matches: false, needsRehash: false },
    ]);
  });

  it("salts each hash, so one password never gives the same text twice", async () => {
    const passwords = createPasswordHasher();

    const [first, second] = await Promise.all([
      passwords.hash("correct horse battery"),
      passwords.hash("correct horse battery"),
    ]);

    expect(first).not.toBe(second);
  });

  it("flags a hash with weaker parameters for replacing when the password matches", async () => {
    const passwords = createPasswordHasher();

    const check = await passwords.check("correct horse battery", weakHash("correct horse battery"));

    expect(check).toEqual({ matches: true, needsRehash: true });
  });

  it("never matches without a stored hash, after the same work as for a real one", async () => {
    const passwords = createPasswordHasher();

    const check = await passwords.check("correct horse battery", undefined);

    expect(check).toEqual({ matches: false, needsRehash: false });
  });

  it("does not match a hash in a format it does not know", async () => {
    const passwords = createPasswordHasher();

    const check = await passwords.check("correct horse battery", "plain-text-password");

    expect(check.matches).toBe(false);
  });

  it("does not match a hash whose parameters scrypt refuses", async () => {
    const passwords = createPasswordHasher();

    const check = await passwords.check("correct horse battery", "scrypt$3$8$3$AAAA$AAAA");

    expect(check.matches).toBe(false);
  });
});
