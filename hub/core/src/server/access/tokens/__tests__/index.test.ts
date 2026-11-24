import { describe, expect, it } from "vitest";

import { createToken, hashToken } from "../index.js";

describe("createToken", () => {
  it("gives 32 random bytes in base64url behind the prefix", () => {
    const token = createToken("mfx_setup_");

    expect(token).toMatch(/^mfx_setup_[\w-]{43}$/);
  });

  it("gives a different token each time", () => {
    expect(createToken()).not.toBe(createToken());
  });
});

describe("hashToken", () => {
  it("is the SHA-256 of the token as hex", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
