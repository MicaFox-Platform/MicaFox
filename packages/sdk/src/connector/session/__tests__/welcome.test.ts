import { describe, expect, it } from "vitest";

import { checkFirstFrame } from "../welcome.js";

const HELLO_MODULES = ["debugger"];

describe("checkFirstFrame", () => {
  it("accepts a welcome of the SDK's protocol version and agrees on its modules", () => {
    const check = checkFirstFrame('{"version":1,"type":"welcome","modules":["debugger"]}', HELLO_MODULES);

    expect(check).toEqual({ ok: true, agreed: new Set(["debugger"]), refused: [] });
  });

  it("rejects a binary frame", () => {
    expect(checkFirstFrame(undefined, HELLO_MODULES)).toEqual({
      ok: false,
      reason: "the hub sent a binary frame before welcome",
    });
  });

  it.each(["not json", "null", '"welcome"', '{"version":1,"type":"breakpoints","breakpoints":[]}', '{"version":1}'])(
    "rejects %s",
    (text) => {
      expect(checkFirstFrame(text, HELLO_MODULES)).toEqual({
        ok: false,
        reason: "the hub sent a frame other than welcome first",
      });
    },
  );

  it("rejects a welcome of another protocol version", () => {
    expect(checkFirstFrame('{"version":2,"type":"welcome"}', HELLO_MODULES)).toEqual({
      ok: false,
      reason: "the hub's welcome has protocol version 2; the SDK speaks 1",
    });
  });

  it("rejects a welcome without a numeric version and does not quote it", () => {
    expect(checkFirstFrame('{"version":"secret-text","type":"welcome"}', HELLO_MODULES)).toEqual({
      ok: false,
      reason: "the hub's welcome has no valid protocol version; the SDK speaks 1",
    });
  });

  it.each([
    { name: "no modules", text: '{"version":1,"type":"welcome"}' },
    { name: "a string as modules", text: '{"version":1,"type":"welcome","modules":"debugger"}' },
    { name: "an object as modules", text: '{"version":1,"type":"welcome","modules":{"debugger":true}}' },
    { name: "null as modules", text: '{"version":1,"type":"welcome","modules":null}' },
  ])("rejects a welcome with $name", ({ text }) => {
    expect(checkFirstFrame(text, HELLO_MODULES)).toEqual({
      ok: false,
      reason: "the hub's welcome has no modules array",
    });
  });

  it("agrees on nothing for a welcome with an empty modules array and refuses every hello module", () => {
    const check = checkFirstFrame('{"version":1,"type":"welcome","modules":[]}', ["debugger", "errors"]);

    expect(check).toEqual({ ok: true, agreed: new Set(), refused: ["debugger", "errors"] });
  });

  it("keeps only the modules the hello listed and refuses the others", () => {
    const text = '{"version":1,"type":"welcome","modules":["logpoints","debugger"]}';

    const check = checkFirstFrame(text, ["debugger", "errors"]);

    expect(check).toEqual({ ok: true, agreed: new Set(["debugger"]), refused: ["errors"] });
  });

  it.each([
    { name: "past the first 32 entries", index: 32, agreed: [], refused: ["debugger"] },
    { name: "the 32nd entry", index: 31, agreed: ["debugger"], refused: [] },
  ])("agrees on a hello module that is $name accordingly", ({ index, agreed, refused }) => {
    const modules = Array.from({ length: index }, (_, position) => `filler-${String(position)}`).concat("debugger");

    const check = checkFirstFrame(JSON.stringify({ version: 1, type: "welcome", modules }), HELLO_MODULES);

    expect(check).toEqual({ ok: true, agreed: new Set(agreed), refused });
  });

  it("skips entries that are not strings", () => {
    const check = checkFirstFrame(
      '{"version":1,"type":"welcome","modules":[1,null,["debugger"],"debugger"]}',
      HELLO_MODULES,
    );

    expect(check).toEqual({ ok: true, agreed: new Set(["debugger"]), refused: [] });
  });
});
