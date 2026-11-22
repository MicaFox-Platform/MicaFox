import { describe, expect, it } from "vitest";

import { redactSecrets } from "../redact.js";

describe("redactSecrets", () => {
  it.each([
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "password",
    "newPassword",
    "token",
    "setupToken",
    "clientSecret",
  ])("redacts %s", (key) => {
    expect(redactSecrets({ [key]: "secret-value" })).toEqual({ [key]: "[redacted]" });
  });

  // Matching by name over-redacts on purpose: a hidden count costs less than a leaked token
  it("also hides fields that only contain the word, such as tokenCount", () => {
    expect(redactSecrets({ tokenCount: 3, keyPrefix: "mfx_pk_ab" })).toEqual({
      tokenCount: "[redacted]",
      keyPrefix: "mfx_pk_ab",
    });
  });

  it("redacts at any depth, inside arrays too", () => {
    const logged = redactSecrets({
      req: { headers: { authorization: "Bearer a", accept: "*/*" } },
      attempts: [{ user: "a", password: "pw" }],
    });

    expect(logged).toEqual({
      req: { headers: { authorization: "[redacted]", accept: "*/*" } },
      attempts: [{ user: "a", password: "[redacted]" }],
    });
  });

  it("keeps other fields and does not change its input", () => {
    const input = { statusCode: 200, headers: { cookie: "sid=1" } };

    const logged = redactSecrets(input);

    expect(logged).toEqual({ statusCode: 200, headers: { cookie: "[redacted]" } });
    expect(input.headers.cookie).toBe("sid=1");
  });

  it("survives a cycle", () => {
    const input: Record<string, unknown> = { name: "a" };
    input.self = input;

    expect(redactSecrets(input)).toEqual({ name: "a", self: "[circular]" });
  });

  it("stops at a depth bound instead of walking a deep payload", () => {
    let deep: Record<string, unknown> = { token: "t" };
    for (let level = 0; level < 40; level += 1) {
      deep = { next: deep };
    }

    expect(JSON.stringify(redactSecrets(deep))).toContain("[too deep]");
  });

  it("leaves class instances to pino's serializers", () => {
    const error = new Error("boom");

    expect(redactSecrets({ err: error }).err).toBe(error);
  });
});
