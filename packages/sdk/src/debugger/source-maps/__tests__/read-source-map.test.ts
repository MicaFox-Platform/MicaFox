import { Buffer } from "node:buffer";
import { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSourceMap } from "../read-source-map.js";

const MAP_TEXT = '{"version":3,"sources":["checkout.ts"],"mappings":"AAAA"}';
const SCRIPT_URL = "file:///app/dist/checkout.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "probex-maps-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeMap = (name: string, text: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
};

describe("readSourceMap with a data: URL", () => {
  it("decodes a base64 map and resolves its sources against the script", async () => {
    const sourceMapUrl = `data:application/json;base64,${Buffer.from(MAP_TEXT).toString("base64")}`;

    const result = await readSourceMap({ url: SCRIPT_URL, sourceMapUrl });

    expect(result).toEqual({ ok: true, text: MAP_TEXT, mapUrl: SCRIPT_URL, bytes: MAP_TEXT.length });
  });

  it("decodes a percent-encoded map with a charset", async () => {
    const sourceMapUrl = `data:application/json;charset=utf-8,${encodeURIComponent(MAP_TEXT)}`;

    const result = await readSourceMap({ url: SCRIPT_URL, sourceMapUrl });

    expect(result).toEqual({ ok: true, text: MAP_TEXT, mapUrl: SCRIPT_URL, bytes: MAP_TEXT.length });
  });

  it.each([
    ["another media type", "data:text/plain;base64,e30="],
    ["no comma", "data:application/json;base64"],
  ])("gives a reason for %s", async (_name, sourceMapUrl) => {
    const result = await readSourceMap({ url: SCRIPT_URL, sourceMapUrl });

    expect(result).toEqual({ ok: false, reason: "the source map data URL is not JSON" });
  });

  it("gives a reason for a broken percent escape", async () => {
    const result = await readSourceMap({ url: SCRIPT_URL, sourceMapUrl: "data:application/json,%E0%A4%A" });

    expect(result).toEqual({ ok: false, reason: "the source map data URL is invalid" });
  });

  it("gives a reason for a map over 8 MiB without decoding it", async () => {
    const sourceMapUrl = `data:application/json;base64,${"A".repeat(11_184_816)}`;

    const result = await readSourceMap({ url: SCRIPT_URL, sourceMapUrl });

    expect(result).toEqual({ ok: false, reason: "the source map is larger than 8 MiB" });
  });
});

describe("readSourceMap with a relative URL", () => {
  it("reads the file beside a script with a file: URL", async () => {
    const mapFile = writeMap("checkout.js.map", MAP_TEXT);
    const url = pathToFileURL(path.join(dir, "checkout.js")).href;

    const result = await readSourceMap({ url, sourceMapUrl: "checkout.js.map" });

    expect(result).toEqual({
      ok: true,
      text: MAP_TEXT,
      mapUrl: pathToFileURL(mapFile).href,
      bytes: MAP_TEXT.length,
    });
  });

  it("reads the file beside a script with an absolute path as its URL", async () => {
    writeMap("checkout.js.map", MAP_TEXT);

    const result = await readSourceMap({ url: path.join(dir, "checkout.js"), sourceMapUrl: "./checkout.js.map" });

    expect(result.ok).toBe(true);
  });

  it("gives a reason without the path when the file is missing", async () => {
    const url = pathToFileURL(path.join(dir, "checkout.js")).href;

    const result = await readSourceMap({ url, sourceMapUrl: "missing.js.map" });

    expect(result).toEqual({ ok: false, reason: "the source map file cannot be read" });
  });

  it("gives a reason for a file over 8 MiB without reading it", async () => {
    const mapFile = writeMap("checkout.js.map", "");
    truncateSync(mapFile, 8 * 1024 * 1024 + 1);
    const url = pathToFileURL(path.join(dir, "checkout.js")).href;

    const result = await readSourceMap({ url, sourceMapUrl: "checkout.js.map" });

    expect(result).toEqual({ ok: false, reason: "the source map is larger than 8 MiB" });
  });

  it("gives a reason without reading for a path that is not a regular file", async () => {
    const url = pathToFileURL(path.join(dir, "checkout.js")).href;

    const result = await readSourceMap({ url, sourceMapUrl: "." });

    expect(result).toEqual({ ok: false, reason: "the source map file cannot be read" });
  });

  it("gives a reason for a protocol-relative URL, which names a host", async () => {
    const result = await readSourceMap({ url: SCRIPT_URL, sourceMapUrl: "//host/share/checkout.js.map" });

    expect(result).toEqual({ ok: false, reason: "the source map URL cannot be resolved" });
  });

  it("gives a reason when the map URL names no local file", async () => {
    const result = await readSourceMap({ url: "file://host/share/checkout.js", sourceMapUrl: "checkout.js.map" });

    expect(result).toEqual({ ok: false, reason: "the source map URL cannot be resolved" });
  });

  it("gives a reason when the script has no file URL to resolve against", async () => {
    const result = await readSourceMap({ url: "dist/checkout.js", sourceMapUrl: "checkout.js.map" });

    expect(result).toEqual({ ok: false, reason: "the source map URL cannot be resolved" });
  });
});

describe("readSourceMap with another scheme", () => {
  it.each([
    "https://cdn.example.com/checkout.js.map",
    "file:///app/dist/checkout.js.map",
    "webpack:///checkout.js.map",
  ])("gives a reason for %s", async (sourceMapUrl) => {
    const result = await readSourceMap({ url: SCRIPT_URL, sourceMapUrl });

    expect(result).toEqual({ ok: false, reason: "the source map URL scheme is not supported" });
  });
});
