import { countSegments, decodeMappings } from "./decode-mappings.js";
import { parseSourceMap } from "./parse-source-map.js";
import { runSliced, WorkBudget } from "./sliced-work.js";
import { sortByOriginal } from "./sort-by-original.js";
import { SourceMapError } from "./source-map-error.js";
import { SourceMapIndex } from "./source-map-index.js";

/**
 * Why a map cannot be used: a fixed reason that never carries map content; `isOverLimit` when the map is larger
 * than the debugger reads, by bytes, JSON values or segments.
 */
export interface DecodeFailure {
  ok: false;
  reason: string;
  isOverLimit: boolean;
}

/** The outcome of decoding: the indexes, or why the map cannot be used. */
export type DecodeResult = { ok: true; map: SourceMapIndex } | DecodeFailure;

/** What a search keeps of a map: its `sourceRoot` and the entries of `sources`, with `null` as an empty string. */
export interface MapSources {
  readonly sourceRoot: string;
  readonly sources: readonly string[];
}

/** The outcome of reading the sources of a map for a search. */
export type SourcesResult = { ok: true; map: MapSources } | DecodeFailure;

// 8 Mi characters, counted in UTF-16 code units; the reader of a map file checks its size in bytes
const MAX_SOURCE_MAP_LENGTH = 8 * 1024 * 1024;
// A unit is a character of mappings or a comparison of the sort, 20 to 40 ns each on a laptop: a slice takes about
// 1 ms, so it stays under 5 ms on a machine several times slower
const UNITS_PER_SLICE = 30_000;

const TOO_LARGE: DecodeFailure = { ok: false, reason: "the source map is larger than 8 MiB", isOverLimit: true };

const decodeSteps = function* (text: string): Generator<void, SourceMapIndex, void> {
  const budget = new WorkBudget(UNITS_PER_SLICE);
  const { sourceRoot, sources, sourceIds, sourceIdsByName, mappings } = yield* parseSourceMap(text, budget);
  // JSON.parse just ran in one piece
  yield;

  const segments = yield* decodeMappings(mappings, sourceIds, budget);
  const originalOrder = yield* sortByOriginal(segments.originalKeys, budget);

  return new SourceMapIndex({ sourceRoot, sources, sourceIdsByName, segments, originalOrder });
};

// The segments are counted as decoding counts them, so a map a search keeps is never over a limit when read by name
const sourcesSteps = function* (text: string): Generator<void, MapSources, void> {
  const budget = new WorkBudget(UNITS_PER_SLICE);
  const { sourceRoot, sources, mappings } = yield* parseSourceMap(text, budget);
  // JSON.parse just ran in one piece
  yield;

  yield* countSegments(mappings, budget);
  return { sourceRoot, sources };
};

// Anything but our own error, such as running out of memory, gets a fixed reason: it could carry map content
const toFailure = (error: unknown): DecodeFailure =>
  error instanceof SourceMapError
    ? { ok: false, reason: error.message, isOverLimit: error.isOverLimit }
    : { ok: false, reason: "the source map cannot be decoded", isOverLimit: false };

/**
 * Decodes the text of a version 3 source map into indexes from original line to generated position and back. It
 * does no I/O and never throws or rejects: any failure comes back as a reason. Decoding runs in slices and yields to
 * the event loop between them; only `JSON.parse` runs in one piece, kept short by the shape check before it.
 */
export const decodeSourceMap = async (text: string): Promise<DecodeResult> => {
  if (text.length > MAX_SOURCE_MAP_LENGTH) {
    return TOO_LARGE;
  }

  try {
    return { ok: true, map: await runSliced(decodeSteps(text)) };
  } catch (error) {
    return toFailure(error);
  }
};

/**
 * Reads only the sources of a version 3 source map, for a search of the bundles: the same checks and limits as
 * `decodeSourceMap`, segments counted but not decoded. Runs in slices and never throws or rejects.
 */
export const readMapSources = async (text: string): Promise<SourcesResult> => {
  if (text.length > MAX_SOURCE_MAP_LENGTH) {
    return TOO_LARGE;
  }

  try {
    return { ok: true, map: await runSliced(sourcesSteps(text)) };
  } catch (error) {
    return toFailure(error);
  }
};
