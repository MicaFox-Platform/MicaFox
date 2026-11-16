import type { PathCandidate } from "./match-path.js";
import { toBaseName, type MappedRecord, type ScriptRecord } from "./script-registry.js";
import type { SourceMapIndex } from "../source-map-decoder/index.js";
import type { MapSource, MapView, SearchedSource, SearchView } from "../source-maps/index.js";

/** The state finding a location reads: the recorded scripts and what is known of their maps. */
export interface LocationContext {
  /** The scripts without a map, outside `node_modules`, whose path ends in a file name. */
  findCandidates: (fileName: string) => ScriptRecord[];
  /** The scripts with a map, outside `node_modules`, with a base name. */
  findMapped: (baseName: string) => MappedRecord[];
  /** Every script with a map outside `node_modules`. */
  listSearchable: () => MappedRecord[];
  viewMap: (script: MappedRecord) => MapView;
  searchView: (script: MappedRecord) => SearchView;
  /** The sources found by searches and reads by name, outside `node_modules`, that end in a file name. */
  findSearched: (fileName: string) => Array<SearchedSource<MappedRecord>>;
  /** Whether a search read is queued or running. */
  isSearching: () => boolean;
  /** The reason of the first map a search found over a limit. */
  searchFailure: () => string | undefined;
}

/**
 * A script or a source of a script's map that an entry may resolve to. For a source: the source as the map writes
 * it, and the map's index from a read by name unless it is unread or was dropped, or why the map cannot be used.
 */
export interface Candidate extends PathCandidate {
  script: ScriptRecord;
  mapping?: Mapping;
}

/** A source of a script's map: as the map writes it, with the map's index or why the map cannot be used. */
export interface Mapping {
  script: MappedRecord;
  source: string;
  index?: SourceMapIndex;
  failure?: string;
}

/** The candidates by name, the maps they still wait for and the reason of the first map that could not be used. */
export interface ByName {
  candidates: Candidate[];
  reads: MappedRecord[];
  failure?: string;
  /** The URLs of the scripts read by name, which a search leaves out. */
  urls: ReadonlySet<string>;
}

/** The candidates a search found, or the maps it still has to read while one is reading. */
export type BySearch =
  { kind: "searching"; searches: MappedRecord[] } | { kind: "searched"; candidates: Candidate[]; failure?: string };

// A source of a map read by name: its index while the map is decoded
const toMapping = (script: MappedRecord, source: MapSource, view: MapView): Mapping => {
  if (view.kind === "failed") {
    return { script, source: source.source, failure: view.reason };
  }

  const index = view.kind === "read" ? view.index : undefined;
  return index === undefined ? { script, source: source.source } : { script, source: source.source, index };
};

// The sources of a map that end in the entry's file name; a map of a bundle may have several
const toSourceCandidates = (
  script: MappedRecord,
  view: Extract<MapView, { kind: "read" }>,
  fileName: string,
): Candidate[] =>
  view.sources.flatMap((source): Candidate[] =>
    source === undefined || source.isDependency || source.segments.at(-1) !== fileName
      ? []
      : [{ segments: source.segments, script, mapping: toMapping(script, source, view) }],
  );

/**
 * The candidates by name: scripts without a map whose path ends in `fileName`, and the sources ending in it of the
 * maps of scripts with its base name. A map of such a script that is unread or loading is waited for.
 * O(candidate scripts × their sources).
 */
export const collectByName = (fileName: string, context: LocationContext): ByName => {
  const plain = context.findCandidates(fileName).map((script): Candidate => ({ segments: script.segments, script }));
  const collected: ByName & { urls: Set<string> } = { candidates: plain, reads: [], urls: new Set() };
  for (const script of context.findMapped(toBaseName(fileName))) {
    collected.urls.add(script.url);
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

/**
 * The candidates of a search of the bundles: the sources ending in `fileName` of the maps of every other script
 * with a map outside `node_modules`. While a map is unsearched or a search read is running, it lists the maps to
 * search. O(searchable scripts + sources found).
 */
export const collectSearched = (fileName: string, byName: ByName, context: LocationContext): BySearch => {
  const searches = context
    .listSearchable()
    .filter((script) => !byName.urls.has(script.url) && context.searchView(script) === "unsearched");
  if (searches.length > 0 || context.isSearching()) {
    return { kind: "searching", searches };
  }

  const candidates = context
    .findSearched(fileName)
    .flatMap(({ script, source }): Candidate[] =>
      byName.urls.has(script.url)
        ? []
        : [{ segments: source.segments, script, mapping: toMapping(script, source, context.viewMap(script)) }],
    );
  const failure = context.searchFailure();
  return failure === undefined ? { kind: "searched", candidates } : { kind: "searched", candidates, failure };
};
