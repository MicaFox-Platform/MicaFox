import { describe, expect, it } from "vitest";

import { HttpProblem } from "../../../app/index.js";
import { normalizeName } from "../names.js";

describe("normalizeName", () => {
  it("trims the name", () => {
    expect(normalizeName("  Billing \n")).toBe("Billing");
  });

  it("stores a letter typed with a combining accent as the one composed letter", () => {
    expect(normalizeName("Cafe\u0301")).toBe("Caf\u00E9");
  });

  it("keeps the case and inner spaces", () => {
    expect(normalizeName("Billing API")).toBe("Billing API");
  });

  it("accepts 64 characters, counting an emoji as one", () => {
    const name = "😀".repeat(64);

    expect(normalizeName(name)).toBe(name);
  });

  it.each([
    ["is empty", "", "must not be empty"],
    ["is only spaces", "   ", "must not be empty"],
    ["is 65 characters", "a".repeat(65), "must be at most 64 characters"],
    ["holds a newline", "bill\ning", "must not contain control or invisible characters"],
    ["holds a NUL", "bill\u0000ing", "must not contain control or invisible characters"],
    ["holds a zero-width space", "bill\u200Bing", "must not contain control or invisible characters"],
    ["holds a right-to-left override", "bill\u202Eing", "must not contain control or invisible characters"],
    ["holds a line separator", "bill\u2028ing", "must not contain control or invisible characters"],
  ])("rejects a name that %s", (_case, raw, message) => {
    expect(() => normalizeName(raw)).toThrow(
      new HttpProblem("validation", {
        detail: `name: ${message}`,
        errors: [{ path: "/name", in: "body", message }],
      }),
    );
  });
});
