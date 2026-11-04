import type { ValidEntry } from "./entry.js";
import { matchPath, type PathCandidate } from "./match-path.js";
import { toBaseName, type MappedRecord, type ScriptRecord } from "./script-registry.js";
import type { ScriptPosition } from "./v8-breakpoints.js";
import type { SourceMapIndex } from "../source-map-decoder/index.js";
import type { MapView } from "../source-maps/index.js";

/**
 * Where an entry's breakpoint goes, or why it cannot be set yet: `reads` are the maps it waits for, and a retryable
 * error is resolved again when a matching script loads.
 */
export type Location =
  | { kind: "pending"; reads: MappedRecord[] }
  | { kind: "error"; message: string; isRetryable?: boolean }
  | { kind: "script"; url: string; position: ScriptPosition; mapped?: MappedRecord };

/** The state `findLocation` reads: the recorded scripts and what is known of their maps. */
export interface LocationContext {
  findCandidates: (fileName: string) => ScriptRecord[];
  findMapped: (baseName: string) => MappedRecord[];
  viewMap: (script: MappedRecord) => MapView;
}

interface Candidate extends PathCandidate {
  script: ScriptRecord;
  /** For a source of a map: the source as the map writes it, and the map's index unless it was dropped. */
  mapping?: { script: MappedRecord; source: string; index?: SourceMapIndex };
}

interface MappedCandidates {
  candidates: Candidate[];
  reads: MappedRecord[];
  /** The reason of the first map that could not be used. */
  failure?: string;
}

/** Whether a pending entry for `fileName` may resolve to `script`: by file name, or by base name through its map. */
export const mayResolveTo = (fileName: string | undefined, script: ScriptRecord): boolean => {
  const scriptName = script.segments.at(-1);
  if (fileName === undefined || scriptName === undefined) {
    return false;
  }

  return script.sourceMapUrl === undefined ? fileName === scriptName : toBaseName(fileName) === toBaseName(scriptName);
};

const NOTHING_TO_READ: Location = { kind: "pending", reads: [] };

const toNoCode = (entry: ValidEntry): Location => ({
  kind: "error",
  message: `no code at or after line ${String(entry.line)}`,
});

// The sources of a map that end in the entry's file name; a map of a bundle may have several
const toSourceCandidates = (
  script: MappedRecord,
  view: Extract<MapView, { kind: "read" }>,
  fileName: string,
): Candidate[] => {
  const candidates: Candidate[] = [];
  for (const { source, segments } of view.sources) {
    if (segments.at(-1) === fileName) {
      const mapping = view.index === undefined ? { script, source } : { script, source, index: view.index };
      candidates.push({ segments, script, mapping });
    }
  }

  return candidates;
};

const collectMapped = (fileName: string, context: LocationContext): MappedCandidates => {
  const collected: MappedCandidates = { candidates: [], reads: [] };
  for (const script of context.findMapped(toBaseName(fileName))) {
    const view = context.viewMap(script);
    switch (view.kind) {
      case "unread":
      case "reading":
        collected.reads.push(script);
        break;
      case "failed":
        collected.failure ??= view.reason;
        break;
      case "read":
        collected.candidates.push(...toSourceCandidates(script, view, fileName));
        break;
    }
  }

  return collected;
};

// The hub counts lines from 1; V8 and source maps from 0
const toScriptLocation = (entry: ValidEntry, candidate: Candidate): Location => {
  const { mapping } = candidate;
  if (mapping === undefined) {
    return { kind: "script", url: candidate.script.url, position: { line: entry.line - 1, column: 0 } };
  }

  // The index of a map no entry held was dropped; reading it again brings it back
  if (mapping.index === undefined) {
    return { kind: "pending", reads: [mapping.script] };
  }

  const position = mapping.index.findGeneratedPosition(mapping.source, entry.line - 1);
  return position === undefined
    ? toNoCode(entry)
    : { kind: "script", url: mapping.script.url, position, mapped: mapping.script };
};

/**
 * Finds the script and position of an entry: among the scripts without a map whose path ends in its file name, and
 * the sources of the maps of scripts with the same base name, the one whose path ends with the most segments of
 * `file`. While a map it may need is unread, the entry waits for it. O(candidate scripts × their sources).
 */
export const findLocation = (entry: ValidEntry, segments: readonly string[], context: LocationContext): Location => {
  const fileName = segments.at(-1);
  if (fileName === undefined) {
    return NOTHING_TO_READ;
  }

  const mapped = collectMapped(fileName, context);
  if (mapped.reads.length > 0) {
    return { kind: "pending", reads: mapped.reads };
  }

  const plain = context.findCandidates(fileName).map((script): Candidate => ({ segments: script.segments, script }));
  const match = matchPath(segments, [...plain, ...mapped.candidates]);
  switch (match.kind) {
    case "none":
      // A script that loads later may still match, so an error from a map that could not be used is retried
      return mapped.failure === undefined
        ? NOTHING_TO_READ
        : { kind: "error", message: mapped.failure, isRetryable: true };
    case "several":
      return { kind: "error", message: "file matches several files" };
    case "one":
      return toScriptLocation(entry, match.candidate);
  }
};
