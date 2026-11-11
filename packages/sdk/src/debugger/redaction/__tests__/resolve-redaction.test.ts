import { describe, expect, it } from "vitest";

import { envOf } from "../../../../test/debugger/fakes.js";
import { resolveRedaction } from "../index.js";

const resolve = (option?: unknown, env: Record<string, string | undefined> = envOf()) => {
  const warnings: string[] = [];
  const rules = resolveRedaction(option, env, (message) => warnings.push(message));
  return { rules, warnings };
};

describe("resolveRedaction", () => {
  it.each([
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "apiKey",
    "accessKey",
    "privateKey",
    "credential",
    "authorization",
    "cookie",
    "session",
    "jwt",
    "bearer",
    "signature",
  ])("always redacts the built-in name %s", (name) => {
    const { rules } = resolve();

    expect(rules.isSecret(name)).toBe(true);
  });

  it("has exactly the 15 built-in rules when nothing is added", () => {
    const { rules, warnings } = resolve();

    expect({ count: rules.count, warnings }).toEqual({ count: 15, warnings: [] });
  });

  it.each(["dbPassword", "API-KEY", "api_key", "user.access.key", "X_AUTHORIZATION_HEADER"])(
    "matches %s by containment after normalizing",
    (name) => {
      const { rules } = resolve();

      expect(rules.isSecret(name)).toBe(true);
    },
  );

  it.each(["username", "orderId", "total", "", "this"])("does not match %s", (name) => {
    const { rules } = resolve();

    expect(rules.isSecret(name)).toBe(false);
  });

  it("adds the names of the redact option and of MICAFOX_REDACT, trimmed", () => {
    const { rules, warnings } = resolve(["iban"], envOf(["MICAFOX_REDACT", " ssn , client_key"]));

    expect({
      added: ["iban", "userSSN", "clientKey", "orderId"].map((name) => rules.isSecret(name)),
      count: rules.count,
      warnings,
    }).toEqual({ added: [true, true, true, false], count: 18, warnings: [] });
  });

  it("counts a name once when it repeats a built-in rule or another entry", () => {
    const { rules } = resolve(["Password", "api-key", "iban"], envOf(["MICAFOX_REDACT", "IBAN"]));

    expect(rules.count).toBe(16);
  });

  it("skips an entry that is empty after normalizing, with a warning, and keeps the others", () => {
    const { rules, warnings } = resolve(["", "_-.", "iban"], envOf(["MICAFOX_REDACT", "ssn,, ,"]));

    expect({ count: rules.count, iban: rules.isSecret("iban"), ssn: rules.isSecret("ssn"), warnings }).toEqual({
      count: 17,
      iban: true,
      ssn: true,
      warnings: [
        "redact has an entry that is not a usable name; it is skipped",
        "redact has an entry that is not a usable name; it is skipped",
        "MICAFOX_REDACT has an entry that is not a usable name; it is skipped",
        "MICAFOX_REDACT has an entry that is not a usable name; it is skipped",
        "MICAFOX_REDACT has an entry that is not a usable name; it is skipped",
      ],
    });
  });

  it("skips an entry that is not a string, with a warning", () => {
    const { rules, warnings } = resolve(["iban", 7, null]);

    expect({ count: rules.count, warnings }).toEqual({
      count: 16,
      warnings: [
        "redact has an entry that is not a usable name; it is skipped",
        "redact has an entry that is not a usable name; it is skipped",
      ],
    });
  });

  it("ignores a redact option that is not an array, with a warning, and keeps the built-in names", () => {
    const { rules, warnings } = resolve("iban");

    expect({ count: rules.count, iban: rules.isSecret("iban"), warnings }).toEqual({
      count: 15,
      iban: false,
      warnings: ["redact must be an array of names; it is ignored"],
    });
  });

  it("treats an empty MICAFOX_REDACT as unset", () => {
    const { rules, warnings } = resolve(undefined, envOf(["MICAFOX_REDACT", ""]));

    expect({ count: rules.count, warnings }).toEqual({ count: 15, warnings: [] });
  });

  it("skips an entry whose getter throws, with a warning, and keeps the others", () => {
    const option = ["iban"];
    Object.defineProperty(option, 1, {
      get: () => {
        throw new Error("entry getter failed");
      },
    });

    const { rules, warnings } = resolve(option);

    expect({ count: rules.count, iban: rules.isSecret("iban"), warnings }).toEqual({
      count: 16,
      iban: true,
      warnings: ["redact has an entry that could not be read; it is skipped"],
    });
  });

  it("ignores a revoked Proxy as redact, with a warning, and keeps the built-in names", () => {
    const { proxy, revoke } = Proxy.revocable(["iban"], {});
    revoke();

    const { rules, warnings } = resolve(proxy);

    expect({ count: rules.count, warnings }).toEqual({
      count: 15,
      warnings: ["redact must be an array of names; it is ignored"],
    });
  });

  it("adds at most 100 names from redact and MICAFOX_REDACT together, with one warning", () => {
    const option = Array.from({ length: 60 }, (_unused, index) => `option${String(index)}x`);
    const env = Array.from({ length: 60 }, (_unused, index) => `env${String(index)}x`).join(",");

    const { rules, warnings } = resolve(option, envOf(["MICAFOX_REDACT", env]));

    expect({
      count: rules.count,
      kept: [rules.isSecret("env39x"), rules.isSecret("env40x")],
      warnings,
    }).toEqual({
      count: 115,
      kept: [true, false],
      warnings: ["redact and MICAFOX_REDACT add at most 100 names; the rest are ignored"],
    });
  });

  it("reads at most 101 entries of a huge sparse redact array", () => {
    const option = new Array<string>(1_000_000_000);
    option[0] = "iban";

    const { rules, warnings } = resolve(option);

    expect({ count: rules.count, warnings: warnings.length }).toEqual({ count: 16, warnings: 100 });
  });

  it("copies redact, so a later change to the app's array has no effect", () => {
    const option = ["iban"];
    const { rules } = resolve(option);

    option.push("ssn");

    expect([rules.isSecret("iban"), rules.isSecret("ssn")]).toEqual([true, false]);
  });

  it("matches a name on its first 256 characters only", () => {
    const { rules } = resolve();

    expect([rules.isSecret(`${"x".repeat(250)}token`), rules.isSecret(`${"x".repeat(256)}token`)]).toEqual([
      true,
      false,
    ]);
  });
});
