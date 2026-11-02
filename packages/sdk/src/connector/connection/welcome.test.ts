import { describe, expect, it } from "vitest";

import { checkFirstFrame } from "./welcome.js";

describe("checkFirstFrame", () => {
  it("accepts a welcome of the SDK's protocol version", () => {
    expect(checkFirstFrame('{"version":1,"type":"welcome"}')).toEqual({ ok: true });
  });

  it("rejects a binary frame", () => {
    expect(checkFirstFrame(undefined)).toEqual({ ok: false, reason: "the hub sent a binary frame before welcome" });
  });

  it.each(["not json", "null", '"welcome"', '{"version":1,"type":"breakpoints","breakpoints":[]}', '{"version":1}'])(
    "rejects %s",
    (text) => {
      expect(checkFirstFrame(text)).toEqual({ ok: false, reason: "the hub sent a frame other than welcome first" });
    },
  );

  it("rejects a welcome of another protocol version", () => {
    expect(checkFirstFrame('{"version":2,"type":"welcome"}')).toEqual({
      ok: false,
      reason: "the hub's welcome has protocol version 2; the SDK speaks 1",
    });
  });

  it("rejects a welcome without a numeric version and does not quote it", () => {
    expect(checkFirstFrame('{"version":"secret-text","type":"welcome"}')).toEqual({
      ok: false,
      reason: "the hub's welcome has no valid protocol version; the SDK speaks 1",
    });
  });
});
