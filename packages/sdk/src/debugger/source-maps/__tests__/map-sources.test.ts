import { describe, expect, it } from "vitest";

import { resolveMapSources } from "../map-sources.js";

const MAP_URL = "file:///app/dist/orders/checkout.js.map";

describe("resolveMapSources", () => {
  it("resolves a relative source against the map's URL", () => {
    expect(resolveMapSources("", ["../../src/orders/checkout.ts"], MAP_URL)).toEqual([
      { source: "../../src/orders/checkout.ts", segments: ["app", "src", "orders", "checkout.ts"] },
    ]);
  });

  it.each(["../../src/", "../../src"])("joins sourceRoot %s and the source with one /", (sourceRoot) => {
    expect(resolveMapSources(sourceRoot, ["orders/checkout.ts"], MAP_URL)).toEqual([
      { source: "orders/checkout.ts", segments: ["app", "src", "orders", "checkout.ts"] },
    ]);
  });

  it("keeps an absolute file: source", () => {
    expect(resolveMapSources("", ["file:///repo/src/checkout.ts"], MAP_URL)).toEqual([
      { source: "file:///repo/src/checkout.ts", segments: ["repo", "src", "checkout.ts"] },
    ]);
  });

  it("takes the path of a source with another scheme", () => {
    expect(resolveMapSources("", ["webpack://app/src/checkout%20page.ts"], MAP_URL)).toEqual([
      { source: "webpack://app/src/checkout%20page.ts", segments: ["src", "checkout page.ts"] },
    ]);
  });

  it("resolves the sources of an inline map against its script's URL", () => {
    expect(resolveMapSources("", ["checkout.ts"], "file:///app/src/checkout.ts")).toEqual([
      { source: "checkout.ts", segments: ["app", "src", "checkout.ts"] },
    ]);
  });

  it("leaves out a null source and one that names no file", () => {
    expect(
      resolveMapSources("", ["", "file://host/share/checkout.ts", "webpack:///%E0%A4%A", "checkout.ts"], MAP_URL),
    ).toEqual([{ source: "checkout.ts", segments: ["app", "dist", "orders", "checkout.ts"] }]);
  });
});
