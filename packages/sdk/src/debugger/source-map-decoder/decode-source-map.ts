import { decodeMappings } from "./decode-mappings.js";
import { parseSourceMap } from "./parse-source-map.js";
import { runSliced, WorkBudget } from "./sliced-work.js";
import { sortByOriginal } from "./sort-by-original.js";
import { SourceMapError } from "./source-map-error.js";
import { SourceMapIndex } from "./source-map-index.js";

/** The outcome of decoding: the indexes, or a fixed reason that never carries map content. */
export type DecodeResult = { ok: true; map: SourceMapIndex } | { ok: false; reason: string };

// 8 Mi characters, counted in UTF-16 code units; the reader of a map file checks its size in bytes
const MAX_SOURCE_MAP_LENGTH = 8 * 1024 * 1024;
// A unit is a character of mappings or a comparison of the sort, 20 to 40 ns each on a laptop: a slice takes about
// 1 ms, so it stays under 5 ms on a machine several times slower
const UNITS_PER_SLICE = 30_000;

const decodeSteps = function* (text: string): Generator<void, SourceMapIndex, void> {
  const budget = new WorkBudget(UNITS_PER_SLICE);
  const { sourceRoot, sources, sourceIds, sourceIdsByName, mappings } = yield* parseSourceMap(text, budget);
  // JSON.parse just ran in one piece
  yield;

  const segments = yield* decodeMappings(mappings, sourceIds, budget);
  const originalOrder = yield* sortByOriginal(segments.originalKeys, budget);

  return new SourceMapIndex({ sourceRoot, sources, sourceIdsByName, segments, originalOrder });
};

/**
 * Decodes the text of a version 3 source map into indexes from original line to generated position and back. It
 * does no I/O and never throws or rejects: any failure comes back as a reason. Decoding runs in slices and yields to
 * the event loop between them; only `JSON.parse` runs in one piece, kept short by the shape check before it.
 */
export const decodeSourceMap = async (text: string): Promise<DecodeResult> => {
  if (text.length > MAX_SOURCE_MAP_LENGTH) {
    return { ok: false, reason: "the source map is larger than 8 MiB" };
  }

  try {
    return { ok: true, map: await runSliced(decodeSteps(text)) };
  } catch (error) {
    // Anything but our own error, such as running out of memory, gets a fixed reason: it could carry map content
    return { ok: false, reason: error instanceof SourceMapError ? error.message : "the source map cannot be decoded" };
  }
};
