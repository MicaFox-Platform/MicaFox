import { describe, expect, it } from "vitest";

import { checkHubTarget } from "./hub-url.js";

const TOKEN = "s3cr3t-token";

describe("checkHubTarget", () => {
  it("rejects a missing URL", () => {
    expect(checkHubTarget(undefined, undefined)).toEqual({
      ok: false,
      reason: "no hub URL is set; pass url or set PROBEX_HUB_URL",
    });
  });

  it.each(["https://hub.example.com/probex", "hub.example.com", "not a url"])("rejects %s", (url) => {
    expect(checkHubTarget(url, undefined)).toEqual({ ok: false, reason: "the hub URL must be a ws:// or wss:// URL" });
  });

  it.each([
    "ws://hub.example.com/probex",
    "ws://127.0.0.1.evil.example/probex",
    "ws://localhost./probex",
    "ws://128.0.0.1/probex",
    "ws://[::2]/probex",
  ])("rejects a token over %s", (url) => {
    expect(checkHubTarget(url, TOKEN)).toEqual({
      ok: false,
      reason: "a token is sent over ws:// only to localhost, 127.0.0.0/8 or [::1]; use wss://",
    });
  });

  it.each([
    "ws://localhost:8080/probex",
    "ws://LOCALHOST/probex",
    "ws://127.0.0.1/probex",
    "ws://127.255.3.4/probex",
    "ws://127.1/probex",
    "ws://[::1]:8080/probex",
    "ws://[0:0::1]/probex",
    "wss://hub.example.com/probex",
  ])("accepts a token over %s", (url) => {
    expect(checkHubTarget(url, TOKEN).ok).toBe(true);
  });

  it("accepts ws:// to any host without a token", () => {
    expect(checkHubTarget("ws://hub.example.com/probex", undefined).ok).toBe(true);
  });

  it("rejects a token that an HTTP header cannot carry", () => {
    expect(checkHubTarget("wss://hub.example.com/probex", "abc\r\nX-Injected: 1")).toEqual({
      ok: false,
      reason: "the token contains characters an HTTP header cannot carry",
    });
  });

  it("drops the userinfo and the fragment from the URL it connects to, and keeps the query", () => {
    const check = checkHubTarget("wss://user:pass@hub.example.com:8443/probex?team=eu#frag", undefined);

    expect(check).toEqual({
      ok: true,
      target: {
        href: "wss://hub.example.com:8443/probex?team=eu",
        isSecure: true,
        description: "wss://hub.example.com:8443/probex",
      },
    });
  });

  it("describes a ws:// URL by origin and path only", () => {
    const check = checkHubTarget("ws://user@localhost/probex?key=private", TOKEN);

    expect(check).toMatchObject({ ok: true, target: { isSecure: false, description: "ws://localhost/probex" } });
  });
});
