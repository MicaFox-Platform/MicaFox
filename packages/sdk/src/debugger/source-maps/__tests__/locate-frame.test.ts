import { describe, expect, it } from "vitest";

import { createSourceMapText, encodeMappings } from "../../../../test/source-maps/encode-mappings.js";
import { decodeSourceMap } from "../../source-map-decoder/index.js";
import { locateFrame } from "../locate-frame.js";
import { resolveMapSources } from "../map-sources.js";
import type { MapView } from "../source-maps.js";

const MAP_URL = "file:///app/dist/checkout.js.map";
const SCRIPT_URL = "file:///app/dist/checkout.js";

// Generated line 7 (0-based) has a segment at column 4 that maps to original line 7, column 2 of source 0
const decodeIndex = async () => {
  const mappings = encodeMappings([[], [], [], [], [], [], [], [{ column: 4, source: 0, line: 7, originalColumn: 2 }]]);
  const decoded = await decodeSourceMap(createSourceMapText(["../src/checkout.ts"], mappings));
  if (!decoded.ok) {
    throw new Error("the fixture map must decode");
  }

  return decoded.map;
};

const readView = async (sourceName = "../src/checkout.ts"): Promise<MapView> => ({
  kind: "read",
  sources: resolveMapSources("", [sourceName], MAP_URL),
  index: await decodeIndex(),
});

describe("locateFrame", () => {
  it("gives the original path and 1-based position where the map is decoded", async () => {
    const view = await readView();

    expect(locateFrame(SCRIPT_URL, view, { line: 7, column: 4 })).toEqual({
      file: "/app/src/checkout.ts",
      line: 8,
      column: 3,
    });
  });

  it("maps a position after a segment to that segment", async () => {
    const view = await readView();

    expect(locateFrame(SCRIPT_URL, view, { line: 7, column: 30 })).toEqual({
      file: "/app/src/checkout.ts",
      line: 8,
      column: 3,
    });
  });

  it("keeps the generated path and position on a line the map has no segment for", async () => {
    const view = await readView();

    expect(locateFrame(SCRIPT_URL, view, { line: 2, column: 0 })).toEqual({
      file: "/app/dist/checkout.js",
      line: 3,
      column: 1,
    });
  });

  it("keeps the generated position when the source of the segment is not among the resolved ones", async () => {
    const view: MapView = {
      kind: "read",
      sources: resolveMapSources("", ["../src/other.ts"], MAP_URL),
      index: await decodeIndex(),
    };

    expect(locateFrame(SCRIPT_URL, view, { line: 7, column: 4 })).toEqual({
      file: "/app/dist/checkout.js",
      line: 8,
      column: 5,
    });
  });

  it.each<[string, MapView]>([
    ["unread", { kind: "unread" }],
    ["being read", { kind: "reading" }],
    ["failed", { kind: "failed", reason: "invalid" }],
    ["read without its index", { kind: "read", sources: [] }],
  ])("keeps the generated path and position when the map is %s", (_name, view) => {
    expect(locateFrame(SCRIPT_URL, view, { line: 7, column: 4 })).toEqual({
      file: "/app/dist/checkout.js",
      line: 8,
      column: 5,
    });
  });
});

describe("locateFrame script paths", () => {
  const UNREAD: MapView = { kind: "unread" };

  it.each([
    ["a file: URL as a path", "file:///app/dist/checkout.js", "/app/dist/checkout.js"],
    ["an encoded file: URL decoded", "file:///app/my%20dir/checkout.js", "/app/my dir/checkout.js"],
    ["a node: URL as it is", "node:internal/modules/cjs/loader", "node:internal/modules/cjs/loader"],
    ["a file: URL with a host as it is", "file://host/share/checkout.js", "file://host/share/checkout.js"],
    ["an empty URL as <anonymous>", "", "<anonymous>"],
    ["a missing URL as <anonymous>", undefined, "<anonymous>"],
  ])("shows %s", (_name, url, file) => {
    expect(locateFrame(url, UNREAD, { line: 0, column: 0 }).file).toBe(file);
  });
});
