import { describe, expect, it } from "vitest";

import {
  parseBoolean,
  parseChoice,
  parseDatabaseUrl,
  parseInteger,
  parsePassword,
  parseProjectKey,
  parsePublicUrl,
  parseSourceUrl,
  parseTrustProxy,
} from "../parse-setting.js";

describe("parsePublicUrl", () => {
  it.each(["https://hub.example.com", "http://localhost:8080", "http://127.0.0.1:3000", "http://[::1]:8080"])(
    "accepts %s",
    (raw) => {
      expect(parsePublicUrl(raw)).toEqual({ ok: true, value: new URL(raw).origin });
    },
  );

  it.each(["http://hub.example.com", "http://10.0.0.5:8080", "http://localhost.example.com"])(
    "rejects HTTP on another host: %s",
    (raw) => {
      expect(parsePublicUrl(raw)).toMatchObject({ ok: false });
    },
  );

  it.each([
    "https://hub.example.com/micafox",
    "https://user:secret@hub.example.com",
    "https://a.com/?x=1",
    "ftp://a.com",
    "hub",
  ])("rejects %s", (raw) => {
    expect(parsePublicUrl(raw)).toMatchObject({ ok: false });
  });

  it("never repeats the rejected value", () => {
    const result = parsePublicUrl("https://user:secret@hub.example.com");

    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("parseSourceUrl", () => {
  it("accepts a plain URL and rejects one with credentials or another scheme", () => {
    expect([
      parseSourceUrl("https://git.example.com/hub").ok,
      parseSourceUrl("https://user:token@git.example.com/hub").ok,
      parseSourceUrl("ssh://git.example.com/hub").ok,
    ]).toEqual([true, false, false]);
  });
});

describe("parseDatabaseUrl", () => {
  it.each(["postgres://app:pw@db:5432/hub", "postgresql://db/hub", "pglite:memory", "pglite:/var/data"])(
    "accepts %s",
    (raw) => {
      expect(parseDatabaseUrl(raw)).toEqual({ ok: true, value: raw });
    },
  );

  it.each(["mysql://db/hub", "pglite:", "postgres://", "db"])("rejects %s", (raw) => {
    expect(parseDatabaseUrl(raw)).toMatchObject({ ok: false });
  });
});

describe("parseTrustProxy", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["2", 2],
    ["10.0.0.1", ["10.0.0.1"]],
    ["10.0.0.0/8, 192.168.1.1", ["10.0.0.0/8", "192.168.1.1"]],
    ["fd00::/8", ["fd00::/8"]],
  ])("reads %s", (raw, value) => {
    expect(parseTrustProxy(raw)).toEqual({ ok: true, value });
  });

  it.each(["yes", "10.0.0.0/33", "10.0.0.0/8/1", "256.1.1.1", "300", "10.0.0.1,"])("rejects %s", (raw) => {
    expect(parseTrustProxy(raw)).toMatchObject({ ok: false });
  });
});

describe("parseInteger", () => {
  it.each(["0", "8080", "65535"])("accepts %s as a port", (raw) => {
    expect(parseInteger(raw, 0, 65_535)).toEqual({ ok: true, value: Number(raw) });
  });

  it.each(["-1", "65536", "80.5", "1e3", "", "abc", "99999999999999999999"])("rejects %s as a port", (raw) => {
    expect(parseInteger(raw, 0, 65_535)).toMatchObject({ ok: false });
  });
});

describe("small parsers", () => {
  it("reads booleans", () => {
    expect([parseBoolean("true"), parseBoolean("false"), parseBoolean("1")]).toEqual([
      { ok: true, value: true },
      { ok: true, value: false },
      { ok: false, problem: "must be true or false" },
    ]);
  });

  it("rejects a word outside the choices and names the choices", () => {
    expect(parseChoice("trace", ["debug", "info"])).toEqual({ ok: false, problem: "must be one of debug, info" });
  });

  it("checks the project key shape", () => {
    expect([parseProjectKey(`mfx_pk_${"a".repeat(43)}`).ok, parseProjectKey("mfx_pk_short").ok]).toEqual([true, false]);
  });

  it("checks the password length", () => {
    expect([
      parsePassword("x".repeat(11)).ok,
      parsePassword("x".repeat(12)).ok,
      parsePassword("x".repeat(257)).ok,
    ]).toEqual([false, true, false]);
  });
});
