import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A loaded script that names a source map. */
export interface MappedScript {
  /** As V8 reported it: a `file:` URL or an absolute path. */
  readonly url: string;
  /** The `sourceMappingURL` of the script, as written. */
  readonly sourceMapUrl: string;
}

/** The text of a map and the URL its sources are resolved against, or a fixed reason that never carries a URL. */
export type ReadResult = { ok: true; text: string; mapUrl: string; bytes: number } | { ok: false; reason: string };

/** 8 MiB, the largest map the debugger reads. */
export const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024;

const TOO_LARGE = "the source map is larger than 8 MiB";
const UNREADABLE = "the source map file cannot be read";
// A scheme is letters, digits, `+`, `-` and `.` after a letter, then `:`; a relative URL has none
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const JSON_MEDIA_TYPE = "application/json";

/** The `file:` URL of a script, whose URL is either one or an absolute path. */
const toScriptFileUrl = (url: string): string | undefined => {
  if (url.startsWith("file:")) {
    return url;
  }

  return isAbsolute(url) ? pathToFileURL(url).href : undefined;
};

// data:[<media type>][;base64],<data>, where the media type may carry parameters such as `charset=utf-8`
const readDataUrl = (script: MappedScript): ReadResult => {
  const url = script.sourceMapUrl;
  const comma = url.indexOf(",");
  const header = comma < 0 ? "" : url.slice("data:".length, comma).toLowerCase();
  const parts = header.split(";").map((part) => part.trim());
  if (comma < 0 || parts[0] !== JSON_MEDIA_TYPE) {
    return { ok: false, reason: "the source map data URL is not JSON" };
  }

  const data = url.slice(comma + 1);
  const isBase64 = parts.includes("base64");
  // A base64 text is a third larger than its bytes; a percent-encoded one is never smaller than its text
  const bytes = isBase64 ? Math.floor((data.length * 3) / 4) : data.length;
  if (bytes > MAX_SOURCE_MAP_BYTES) {
    return { ok: false, reason: TOO_LARGE };
  }

  try {
    const text = isBase64 ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
    return { ok: true, text, mapUrl: script.url, bytes: Buffer.byteLength(text) };
  } catch {
    // decodeURIComponent throws on a `%` that starts no valid escape
    return { ok: false, reason: "the source map data URL is invalid" };
  }
};

const toMapPath = (script: MappedScript): { path: string; mapUrl: string } | undefined => {
  const base = toScriptFileUrl(script.url);
  if (base === undefined) {
    return undefined;
  }

  try {
    const mapUrl = new URL(script.sourceMapUrl, base);
    // A protocol-relative `//host/x.map` keeps its host, which Windows would read as a network share
    return mapUrl.host === "" ? { path: fileURLToPath(mapUrl), mapUrl: mapUrl.href } : undefined;
  } catch {
    // A URL that does not resolve names no local file
    return undefined;
  }
};

// O_NONBLOCK keeps opening a FIFO from waiting for a writer; Windows has no such flag and no FIFOs to open
const OPEN_FLAGS = constants.O_RDONLY | ((constants.O_NONBLOCK as number | undefined) ?? 0);

// Reads at most `size + 1` bytes: a file that grew since its size was taken is caught instead of read to its end
const readExactly = async (handle: FileHandle, size: number): Promise<Buffer | undefined> => {
  const buffer = Buffer.alloc(size + 1);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    total += bytesRead;
    if (bytesRead === 0 || total === buffer.length) {
      return total === size ? buffer.subarray(0, size) : undefined;
    }
  }
};

// The size is checked on the open file before it is read, so a larger map is never loaded into memory. Only a
// regular file is read: a device or a FIFO has no size to check
const readMapFile = async (path: string): Promise<{ text: string; bytes: number } | { reason: string }> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, OPEN_FLAGS);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { reason: UNREADABLE };
    }

    if (stats.size > MAX_SOURCE_MAP_BYTES) {
      return { reason: TOO_LARGE };
    }

    const bytes = await readExactly(handle, stats.size);
    return bytes === undefined ? { reason: UNREADABLE } : { text: bytes.toString("utf8"), bytes: stats.size };
  } catch {
    // The error names the path, so a fixed reason is returned instead
    return { reason: UNREADABLE };
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * Reads the source map a script names: a `data:` URL in place, a relative URL from the file beside the script.
 * Any other scheme gives a reason. Never rejects.
 */
export const readSourceMap = async (script: MappedScript): Promise<ReadResult> => {
  if (script.sourceMapUrl.startsWith("data:")) {
    return readDataUrl(script);
  }

  if (SCHEME.test(script.sourceMapUrl)) {
    return { ok: false, reason: "the source map URL scheme is not supported" };
  }

  const located = toMapPath(script);
  if (located === undefined) {
    return { ok: false, reason: "the source map URL cannot be resolved" };
  }

  const file = await readMapFile(located.path);
  return "reason" in file ? { ok: false, reason: file.reason } : { ok: true, ...file, mapUrl: located.mapUrl };
};
