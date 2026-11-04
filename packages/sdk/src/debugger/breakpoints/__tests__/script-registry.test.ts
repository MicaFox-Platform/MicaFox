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
