import { describe, expect, it } from "vitest";

import { resolveMapSources } from "../map-sources.js";

const MAP_URL = "file:///app/dist/orders/checkout.js.map";

describe("resolveMapSources", () => {
  it("resolves a relative source against the map's URL", () => {
    expect(resolveMapSources("", ["../../src/orders/checkout.ts"], MAP_URL)).toEqual([
      {
        source: "../../src/orders/checkout.ts",
        path: "/app/src/orders/checkout.ts",
        segments: ["app", "src", "orders", "checkout.ts"],
        isDependency: false,
      },
    ]);
  });

  it.each(["../../src/", "../../src"])("joins sourceRoot %s and the source with one /", (sourceRoot) => {
    expect(resolveMapSources(sourceRoot, ["orders/checkout.ts"], MAP_URL)).toEqual([
      {
        source: "orders/checkout.ts",
        path: "/app/src/orders/checkout.ts",
        segments: ["app", "src", "orders", "checkout.ts"],
        isDependency: false,
      },
    ]);
  });

  it("keeps an absolute file: source", () => {
    expect(resolveMapSources("", ["file:///repo/src/checkout.ts"], MAP_URL)).toEqual([
      {
        source: "file:///repo/src/checkout.ts",
        path: "/repo/src/checkout.ts",
        segments: ["repo", "src", "checkout.ts"],
        isDependency: false,
      },
    ]);
  });

  it("takes the path of a source with another scheme", () => {
    expect(resolveMapSources("", ["webpack://app/src/checkout%20page.ts"], MAP_URL)).toEqual([
      {
        source: "webpack://app/src/checkout%20page.ts",
        path: "/src/checkout page.ts",
        segments: ["src", "checkout page.ts"],
        isDependency: false,
      },
    ]);
  });

  it("resolves the sources of an inline map against its script's URL", () => {
    expect(resolveMapSources("", ["checkout.ts"], "file:///app/src/checkout.ts")).toEqual([
      {
        source: "checkout.ts",
        path: "/app/src/checkout.ts",
        segments: ["app", "src", "checkout.ts"],
        isDependency: false,
      },
    ]);
  });

  it("keeps a null source and one that names no file as undefined, so each source stays at its id", () => {
    expect(
      resolveMapSources("", ["", "file://host/share/checkout.ts", "webpack:///%E0%A4%A", "checkout.ts"], MAP_URL),
    ).toEqual([
      undefined,
      undefined,
      undefined,
      {
        source: "checkout.ts",
        path: "/app/dist/orders/checkout.ts",
        segments: ["app", "dist", "orders", "checkout.ts"],
        isDependency: false,
      },
    ]);
  });

  it.each([
    ["webpack://app/./src/checkout.ts", ["src", "checkout.ts"]],
    ["turbopack:///[project]/src/checkout.ts", ["[project]", "src", "checkout.ts"]],
  ])("drops the scheme, host and . segments of %s", (source, segments) => {
    expect(resolveMapSources("", [source], MAP_URL)[0]?.segments).toEqual(segments);
  });

  it("marks a source under node_modules as a dependency", () => {
    const [source] = resolveMapSources("", ["../../node_modules/next/dist/server/utils.ts"], MAP_URL);

    expect(source).toMatchObject({ path: "/app/node_modules/next/dist/server/utils.ts", isDependency: true });
  });
});
