import { describe, expect, it } from "vitest";

import { ScriptRegistry, toBaseName } from "../script-registry.js";

describe("ScriptRegistry", () => {
  it("records a script with a file URL", () => {
    const registry = new ScriptRegistry();

    registry.record({ url: "file:///app/src/checkout.js", sourceMapURL: "" });

    expect(registry.findCandidates("checkout.js")).toEqual([
      { url: "file:///app/src/checkout.js", segments: ["app", "src", "checkout.js"] },
    ]);
  });

  it("records a script with an absolute path as its URL", () => {
    const registry = new ScriptRegistry();

    registry.record({ url: "/app/src/checkout.js" });

    expect(registry.findCandidates("checkout.js").map((script) => script.url)).toEqual(["/app/src/checkout.js"]);
  });

  it.each([
    ["no URL", {}],
    ["an empty URL", { url: "" }],
    ["a node: URL", { url: "node:internal/modules/cjs/loader" }],
    ["a relative path", { url: "src/checkout.js" }],
    ["an http URL", { url: "http://localhost/checkout.js" }],
    ["a file URL with a host", { url: "file://host/share/checkout.js" }],
    ["a URL that is not a string", { url: 7 }],
    ["params that are not an object", null],
  ])("ignores a script with %s", (_name, params) => {
    const registry = new ScriptRegistry();

    const recorded = registry.record(params);

    expect({ recorded, found: registry.findCandidates("checkout.js") }).toEqual({ recorded: undefined, found: [] });
  });

  it("replaces the record of a URL", () => {
    const registry = new ScriptRegistry();
    registry.record({ url: "file:///app/checkout.js", sourceMapURL: "" });

    registry.record({ url: "file:///app/checkout.js", sourceMapURL: "checkout.js.map" });

    expect(registry.findCandidates("checkout.js")).toEqual([]);
  });

  it("keeps one record per URL and finds those with the same file name", () => {
    const registry = new ScriptRegistry();
    registry.record({ url: "file:///a/checkout.js" });
    registry.record({ url: "file:///a/checkout.js" });
    registry.record({ url: "file:///b/checkout.js" });

    expect(registry.findCandidates("checkout.js").map((script) => script.url)).toEqual([
      "file:///a/checkout.js",
      "file:///b/checkout.js",
    ]);
  });

  it("does not offer a script with a source map as a candidate", () => {
    const registry = new ScriptRegistry();
    registry.record({ url: "file:///app/checkout.js", sourceMapURL: "data:application/json;base64,e30=" });

    expect(registry.findCandidates("checkout.js")).toEqual([]);
  });

  it("matches whole file names only", () => {
    const registry = new ScriptRegistry();
    registry.record({ url: "file:///app/mycheckout.js" });

    expect(registry.findCandidates("checkout.js")).toEqual([]);
  });

  it("records the source map URL of a script and finds it by base name", () => {
    const registry = new ScriptRegistry();

    registry.record({ url: "file:///app/dist/checkout.js", sourceMapURL: "checkout.js.map" });

    expect(registry.findMapped("checkout")).toEqual([
      {
        url: "file:///app/dist/checkout.js",
        segments: ["app", "dist", "checkout.js"],
        sourceMapUrl: "checkout.js.map",
      },
    ]);
  });

  it("does not find a script without a map by base name", () => {
    const registry = new ScriptRegistry();

    registry.record({ url: "file:///app/dist/checkout.js", sourceMapURL: "" });

    expect(registry.findMapped("checkout")).toEqual([]);
  });

  it("drops a script from the base-name index when its URL is recorded again without a map", () => {
    const registry = new ScriptRegistry();
    registry.record({ url: "file:///app/dist/checkout.js", sourceMapURL: "checkout.js.map" });

    registry.record({ url: "file:///app/dist/checkout.js" });

    expect(registry.findMapped("checkout")).toEqual([]);
  });

  it("forgets every record on clear", () => {
    const registry = new ScriptRegistry();
    registry.record({ url: "file:///app/checkout.js" });
    registry.record({ url: "file:///app/invoice.js", sourceMapURL: "invoice.js.map" });

    registry.clear();

    expect({ plain: registry.findCandidates("checkout.js"), mapped: registry.findMapped("invoice") }).toEqual({
      plain: [],
      mapped: [],
    });
  });
});

describe("toBaseName", () => {
  it.each([
    ["checkout.ts", "checkout"],
    ["checkout.test.ts", "checkout.test"],
    ["Makefile", "Makefile"],
    [".env", ".env"],
  ])("gives %s without its last extension", (fileName, expected) => {
    expect(toBaseName(fileName)).toBe(expected);
  });
});

describe("ScriptRegistry frame scripts", () => {
  it("finds a file script by its id, with its record", () => {
    const registry = new ScriptRegistry();

    const record = registry.record({ scriptId: "12", url: "file:///app/src/checkout.js" });

    expect(registry.findFrameScript("12")).toEqual({ url: "file:///app/src/checkout.js", record });
  });

  it("finds a script of Node itself by its id, without a record", () => {
    const registry = new ScriptRegistry();

    const record = registry.record({ scriptId: "3", url: "node:internal/modules/cjs/loader" });

    expect({ record, found: registry.findFrameScript("3") }).toEqual({
      record: undefined,
      found: { url: "node:internal/modules/cjs/loader" },
    });
  });

  it.each([
    ["no URL", { scriptId: "1" }],
    ["an empty URL, as eval has", { scriptId: "1", url: "" }],
  ])("does not keep a script with %s", (_name, params) => {
    const registry = new ScriptRegistry();

    registry.record(params);

    expect(registry.findFrameScript("1")).toBeUndefined();
  });

  it("does not keep a script whose id is not a string", () => {
    const registry = new ScriptRegistry();

    registry.record({ scriptId: 1, url: "node:fs" });

    expect([registry.findFrameScript("1"), registry.findFrameScript("undefined")]).toEqual([undefined, undefined]);
  });

  it("keeps the script of an id when the same URL is recorded again under another id", () => {
    const registry = new ScriptRegistry();
    registry.record({ scriptId: "1", url: "file:///app/src/checkout.js" });

    registry.record({ scriptId: "2", url: "file:///app/src/checkout.js" });

    expect([registry.findFrameScript("1")?.url, registry.findFrameScript("2")?.url]).toEqual([
      "file:///app/src/checkout.js",
      "file:///app/src/checkout.js",
    ]);
  });

  it("drops the oldest script when more than 20,000 are kept", () => {
    const registry = new ScriptRegistry();

    for (let id = 1; id <= 20_001; id += 1) {
      registry.record({ scriptId: String(id), url: `node:internal/script-${String(id)}` });
    }

    expect({ first: registry.findFrameScript("1"), second: registry.findFrameScript("2")?.url }).toEqual({
      first: undefined,
      second: "node:internal/script-2",
    });
  });

  it("keeps a script recorded again under its id as the newest, so the next eviction spares it", () => {
    const registry = new ScriptRegistry();
    for (let id = 1; id <= 20_000; id += 1) {
      registry.record({ scriptId: String(id), url: `node:internal/script-${String(id)}` });
    }

    registry.record({ scriptId: "1", url: "node:internal/script-1" });
    registry.record({ scriptId: "20001", url: "node:internal/script-20001" });

    expect({ first: registry.findFrameScript("1")?.url, second: registry.findFrameScript("2") }).toEqual({
      first: "node:internal/script-1",
      second: undefined,
    });
  });

  it("forgets every script on clear()", () => {
    const registry = new ScriptRegistry();
    registry.record({ scriptId: "1", url: "node:fs" });

    registry.clear();

    expect(registry.findFrameScript("1")).toBeUndefined();
  });
});
