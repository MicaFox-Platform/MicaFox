import {
  collectByName,
  collectSearched,
  type ByName,
  type Candidate,
  type LocationContext,
} from "./collect-candidates.js";
import { matchPath, type PathMatch } from "./match-path.js";
import { toBaseName, type MappedRecord, type ScriptRecord } from "./script-registry.js";

/** A position in a script: 0-based line and column, as V8 and source maps count. */
export interface ScriptPosition {
  line: number;
  column: number;
}

/** What finding a location reads of an entry: its 1-based line; its file comes split into segments. */
export interface LocatedEntry {
  line: number;
}

/** A script an entry's breakpoint goes in, and the script whose map placed it there. */
export interface Target {
  url: string;
  position: ScriptPosition;
  mapped?: MappedRecord;
}

/**
 * Where an entry's breakpoints go, or why they cannot be set yet: `reads` are the maps it waits for by name and
 * `searches`, when present, the maps it waits for while it searches the bundles; a retryable error is resolved
 * again when a matching script loads. An entry whose search found nothing keeps searching the scripts that load
 * later: it is pending with no search left, or a retryable error, with `isSearching`. `winningPath` is the path of the source a search found, which a script that
 * loads later may also hold.
 */
export type Location =
  | { kind: "pending"; reads: MappedRecord[]; searches?: MappedRecord[] }
  | { kind: "error"; message: string; isRetryable?: boolean; isSearching?: boolean }
  | { kind: "scripts"; targets: Target[]; winningPath?: string };

/**
 * The scripts a source found by a search later is in, the maps of those still waiting for a read by name, and the
 * URLs of the scripts whose map is read but has no code at the entry's line.
 */
export interface AddedTargets {
  targets: Target[];
  reads: MappedRecord[];
  withoutCode: string[];
}

/** Whether a pending entry for `fileName` may resolve to `script`: by file name, or by base name through its map. */
export const mayResolveTo = (fileName: string | undefined, script: ScriptRecord): boolean => {
  const scriptName = script.segments.at(-1);
  if (fileName === undefined || scriptName === undefined) {
    return false;
  }

  return script.sourceMapUrl === undefined ? fileName === scriptName : toBaseName(fileName) === toBaseName(scriptName);
};

/** The path a candidate's segments name, which compares the winners of a search with later sources. */
export const toWinningPath = (segments: readonly string[]): string => segments.join("/");

const NOTHING_TO_READ: Location = { kind: "pending", reads: [] };

const toNoCode = (entry: LocatedEntry): Location => ({
  kind: "error",
  message: `no code at or after line ${String(entry.line)}`,
});

interface LocationRequest {
  entry: LocatedEntry;
  segments: readonly string[];
}

/** An entry a search set: the path it won with and the URLs of the scripts it is set in. */
export interface SearchPlacement {
  winningPath: string;
  /** The URLs of the scripts to leave out: the entry is set in them, or was tried there. */
  urls: ReadonlySet<string>;
}

interface Resolved {
  targets: Target[];
  reads: MappedRecord[];
  failure?: string;
}

// The hub counts lines from 1; V8 and source maps from 0. The index of a map no entry held was dropped, and one a
// search found was never decoded: reading it by name brings it. A map may list one path twice, so each script gives
// one target, from its first candidate
const toTargets = (entry: LocatedEntry, candidates: readonly Candidate[]): Resolved => {
  const resolved: Resolved = { targets: [], reads: [] };
  const seen = new Set<string>();
  for (const { script, mapping } of candidates) {
    if (seen.has(script.url)) {
      continue;
    }

    seen.add(script.url);
    if (mapping === undefined) {
      resolved.targets.push({ url: script.url, position: { line: entry.line - 1, column: 0 } });
    } else if (mapping.failure !== undefined) {
      resolved.failure ??= mapping.failure;
    } else if (mapping.index === undefined) {
      resolved.reads.push(mapping.script);
    } else {
      const position = mapping.index.findGeneratedPosition(mapping.source, entry.line - 1);
      if (position !== undefined) {
        resolved.targets.push({ url: mapping.script.url, position, mapped: mapping.script });
      }
    }
  }

  return resolved;
};

// Winners with no code at or after the line are left out; an entry none of whose winners has code gets an error
const toLocation = (entry: LocatedEntry, candidates: readonly Candidate[], winningPath?: string): Location => {
  const { targets, reads, failure } = toTargets(entry, candidates);
  if (reads.length > 0) {
    return { kind: "pending", reads };
  }

  if (targets.length === 0) {
    return failure === undefined ? toNoCode(entry) : { kind: "error", message: failure, isRetryable: true };
  }

  return winningPath === undefined ? { kind: "scripts", targets } : { kind: "scripts", targets, winningPath };
};

const toMatchLocation = (
  entry: LocatedEntry,
  match: PathMatch<Candidate>,
  found: { failure: string | undefined; isSearch: boolean },
): Location => {
  switch (match.kind) {
    case "none":
      // Only a search finds nothing; a script that loads later may still match, so an error from a map that could
      // not be used is retried
      return found.failure === undefined
        ? { kind: "pending", reads: [], searches: [] }
        : { kind: "error", message: found.failure, isRetryable: true, isSearching: true };
    case "several":
      return { kind: "error", message: "file matches several files" };
    case "found": {
      const [first] = match.candidates;
      const winningPath = found.isSearch && first !== undefined ? toWinningPath(first.segments) : undefined;
      return toLocation(entry, match.candidates, winningPath);
    }
  }
};

// docs/architecture/sdk/debugger.md#applying-breakpoints: a search only when nothing by name matches the whole path
const searchBundles = (request: LocationRequest, byName: ByName, context: LocationContext): Location => {
  const { entry, segments } = request;
  const fileName = segments.at(-1) ?? "";
  const searched = collectSearched(fileName, byName, context);
  if (searched.kind === "searching") {
    return { kind: "pending", reads: [], searches: searched.searches };
  }

  const match = matchPath(segments, [...byName.candidates, ...searched.candidates]);
  return toMatchLocation(entry, match, { failure: byName.failure ?? searched.failure, isSearch: true });
};

/**
 * Finds the scripts and positions of an entry: among the scripts without a map whose path ends in its file name and
 * the sources of the maps of scripts with the same base name, then, when none ends with every segment of `file`,
 * the sources of every other script's map, the ones whose path ends with the most segments of `file`. While a map
 * it may need is unread, the entry waits for it. O(candidate scripts × their sources + searchable scripts).
 */
export const findLocation = (entry: LocatedEntry, segments: readonly string[], context: LocationContext): Location => {
  const fileName = segments.at(-1);
  if (fileName === undefined) {
    return NOTHING_TO_READ;
  }

  const byName = collectByName(fileName, context);
  if (byName.reads.length > 0) {
    return { kind: "pending", reads: byName.reads };
  }

  const match = matchPath(segments, byName.candidates);
  if (match.kind === "found" && match.count === segments.length) {
    return toMatchLocation(entry, match, { failure: byName.failure, isSearch: false });
  }

  return searchBundles({ entry, segments }, byName, context);
};

/**
 * The scripts outside the entry's whose maps a search found holding its winning path, for an entry a search set: it
 * is also set in a chunk that loads later. O(sources found with its file name).
 */
export const findAddedTargets = (
  entry: LocatedEntry,
  placement: SearchPlacement,
  context: LocationContext,
): AddedTargets => {
  const { winningPath, urls } = placement;
  const fileName = winningPath.slice(winningPath.lastIndexOf("/") + 1);
  const candidates = context.findSearched(fileName).flatMap(({ script, source }): Candidate[] => {
    const view = context.viewMap(script);
    // A map that cannot be read by name is never read again for this record, so it is not waited for
    if (urls.has(script.url) || view.kind === "failed" || toWinningPath(source.segments) !== winningPath) {
      return [];
    }

    const index = view.kind === "read" ? view.index : undefined;
    const mapping = index === undefined ? { script, source: source.source } : { script, source: source.source, index };
    return [{ segments: source.segments, script, mapping }];
  });

  const { targets, reads } = toTargets(entry, candidates);
  const listed = new Set([...targets.map(({ url }) => url), ...reads.map(({ url }) => url)]);
  const withoutCode = [...new Set(candidates.map(({ script }) => script.url))].filter((url) => !listed.has(url));
  return { targets, reads, withoutCode };
};
