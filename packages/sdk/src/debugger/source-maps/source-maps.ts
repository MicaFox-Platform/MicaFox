import { performance } from "node:perf_hooks";

import { resolveMapSources, type MapSource } from "./map-sources.js";
import { ReadQueue } from "./read-queue.js";
import { readSourceMap, type MappedScript } from "./read-source-map.js";
import { SourceSearch, type SearchedSource, type SearchView } from "./source-search.js";
import type { SdkLogger } from "../../logger/index.js";
import {
  decodeSourceMap,
  readMapSources,
  type DecodeFailure,
  type SourceMapIndex,
} from "../source-map-decoder/index.js";

const COMPONENT = "debugger";

/** The most segments the indexes of held maps may have together, about 72 MB at 24 bytes a segment. */
export const MAX_HELD_SEGMENTS = 3_000_000;

/**
 * What is known of a script's map from a read by name: its sources resolved to paths, aligned with the map's
 * `sources` so a source is found by its id, and, while the script holds it, its index.
 */
export type MapView =
  | { kind: "unread" }
  | { kind: "reading" }
  | { kind: "failed"; reason: string }
  | { kind: "read"; sources: ReadonlyArray<MapSource | undefined>; index?: SourceMapIndex };

type NameState<Script> =
  | { kind: "reading"; script: Script }
  | { kind: "failed"; script: Script; failure: DecodeFailure }
  | { kind: "read"; script: Script; sources: ReadonlyArray<MapSource | undefined>; index?: SourceMapIndex };

interface ReadingState<Script> {
  kind: "reading";
  script: Script;
}

type Decoded<Value> = { ok: true; bytes: number; value: Value } | DecodeFailure;
type DecodedMap = Decoded<{ sources: Array<MapSource | undefined>; index: SourceMapIndex }>;
type QueueItem<Script> = { need: "name"; reading: ReadingState<Script> } | { need: "search"; script: Script };

/** What `SourceMaps` needs from the breakpoints; `Script` is their record of a script. */
export interface SourceMapsDependencies<Script extends MappedScript> {
  logger: SdkLogger;
  /** Runs when the read by name of a script's current record ends, so the entries waiting for it are resolved again. */
  onRead: (script: Script) => void;
  /** Runs when the last search read pending ends, so the entries searching the bundles are resolved again. */
  onSearched: () => void;
  /** Reports an unexpected error of a read: the debugger stops itself. */
  fail: (error: unknown) => void;
}

const UNREAD: MapView = { kind: "unread" };

const describeMap = (script: MappedScript): string =>
  script.sourceMapUrl.startsWith("data:") ? `inline in ${script.url}` : `${script.sourceMapUrl} of ${script.url}`;

const toOverLimitReason = (failure: DecodeFailure): string | undefined =>
  failure.isOverLimit ? failure.reason : undefined;

const readAndDecode = async (script: MappedScript): Promise<DecodedMap> => {
  const read = await readSourceMap(script);
  if (!read.ok) {
    return read;
  }

  const decoded = await decodeSourceMap(read.text);
  if (!decoded.ok) {
    return decoded;
  }

  const { map } = decoded;
  const sources = resolveMapSources(map.sourceRoot, map.sources, read.mapUrl);
  return { ok: true, bytes: read.bytes, value: { sources, index: map } };
};

const readSources = async (script: MappedScript): Promise<Decoded<Array<MapSource | undefined>>> => {
  const read = await readSourceMap(script);
  if (!read.ok) {
    return read;
  }

  const found = await readMapSources(read.text);
  return found.ok
    ? { ok: true, bytes: read.bytes, value: resolveMapSources(found.map.sourceRoot, found.map.sources, read.mapUrl) }
    : found;
};

/**
 * The source maps of the loaded scripts, read once per script record and need, by name or for a search of the
 * bundles, and shared by every entry that needs them. Maps are read one at a time, every read by name before any
 * read for a search, so at most one 8 MiB text and one partial index are in memory and the host's thread pool keeps
 * its other threads. The decoded index of a map is kept only while an entry holds its script, at most 3,000,000
 * segments in all; a search keeps only the sources. The states and the queue hold at most one item per recorded
 * script and need, and are dropped with the records.
 */
export class SourceMaps<Script extends MappedScript> {
  private readonly states = new Map<string, NameState<Script>>();
  /** The entries whose breakpoint is set through the map of each script URL. */
  private readonly holders = new Map<string, Set<string>>();
  private readonly search = new SourceSearch<Script>();
  private readonly queue = new ReadQueue<QueueItem<Script>>();
  private isReading = false;

  constructor(private readonly dependencies: SourceMapsDependencies<Script>) {}

  /** What a read by name knows of the map of `script`; a script with the URL of an earlier record starts as unread. */
  view(script: Script): MapView {
    const state = this.states.get(script.url);
    if (state?.script !== script) {
      return UNREAD;
    }

    switch (state.kind) {
      case "reading":
        return { kind: "reading" };
      case "failed":
        return { kind: "failed", reason: state.failure.reason };
      case "read":
        return state.index === undefined
          ? { kind: "read", sources: state.sources }
          : { kind: "read", sources: state.sources, index: state.index };
    }
  }

  /** Queues the map of `script` for a read by name, unless it is queued or what is known already serves every lookup. */
  load(script: Script): void {
    const state = this.states.get(script.url);
    const isKnown = state?.script === script && (state.kind !== "read" || state.index !== undefined);
    if (isKnown) {
      return;
    }

    const reading: ReadingState<Script> = { kind: "reading", script };
    this.states.set(script.url, reading);
    this.queue.push("name", { need: "name", reading });
    this.readNext();
  }

  /** How far the search of `script`'s map got. */
  searchView(script: Script): SearchView {
    return this.search.view(script);
  }

  /**
   * Queues the map of `script` for a search, unless it was searched; what a read by name knows serves it, and a
   * read by name under way settles it. Never ends a search synchronously, so it never calls `onSearched`.
   */
  searchMap(script: Script): void {
    if (this.search.view(script) !== "unsearched") {
      return;
    }

    const state = this.states.get(script.url);
    const byName = state?.script === script ? state : undefined;
    if (byName?.kind === "read") {
      this.search.keep(script, byName.sources);
    } else if (byName?.kind === "failed") {
      this.search.fail(script, toOverLimitReason(byName.failure));
    } else {
      this.search.start(script);
      if (byName === undefined) {
        this.queue.push("search", { need: "search", script });
        this.readNext();
      }
    }
  }

  /** The sources found by searches and reads by name, outside `node_modules`, whose path ends in `fileName`. */
  findSearched(fileName: string): Array<SearchedSource<Script>> {
    return this.search.find(fileName);
  }

  /** Whether a search read is queued or running. */
  isSearching(): boolean {
    return this.search.isSearching();
  }

  /** The reason of the first map a search found over a limit. */
  searchFailure(): string | undefined {
    return this.search.failure();
  }

  /** Forgets the maps of a URL whose script was recorded again; a read of the old record is ignored when it ends. */
  forget(url: string): void {
    this.states.delete(url);
    if (this.search.forget(url)) {
      this.endSearch();
    }
  }

  /**
   * Whether the decoded maps of `scripts` can be held on top of those held already: each map counts once, and all
   * of them together hold at most 3,000,000 segments. O(held maps + scripts).
   */
  canHold(scripts: readonly Script[]): boolean {
    const counted = new Map<string, number>();
    for (const url of [...this.holders.keys(), ...scripts.map((script) => script.url)]) {
      const state = this.states.get(url);
      counted.set(url, state?.kind === "read" ? (state.index?.segmentCount ?? 0) : 0);
    }

    let total = 0;
    for (const count of counted.values()) {
      total += count;
    }

    return total <= MAX_HELD_SEGMENTS;
  }

  /** Keeps the index of `script`'s map while `owner` has a breakpoint set through it. */
  hold(script: Script, owner: string): void {
    const owners = this.holders.get(script.url) ?? new Set<string>();
    owners.add(owner);
    this.holders.set(script.url, owners);
  }

  /** Ends `owner`'s hold on the map of `url`; the index goes with the last owner. */
  release(url: string, owner: string): void {
    const owners = this.holders.get(url);
    owners?.delete(owner);
    if (owners?.size === 0) {
      this.holders.delete(url);
      this.dropIndex(url);
    }
  }

  /** Drops every index no entry holds; for after the last entry waiting for a read has been resolved. */
  trimUnheld(): void {
    for (const [url, state] of this.states) {
      if (state.kind === "read" && state.index !== undefined && !this.holders.has(url)) {
        this.dropIndex(url);
      }
    }
  }

  /** Forgets every map and the queue; a read still running is ignored when it ends. */
  clear(): void {
    this.states.clear();
    this.holders.clear();
    this.search.clear();
    this.queue.clear();
  }

  private dropIndex(url: string): void {
    const state = this.states.get(url);
    if (state?.kind === "read" && state.index !== undefined) {
      this.states.set(url, { kind: "read", script: state.script, sources: state.sources });
    }
  }

  // A queued read whose record was forgotten, read again or searched another way is skipped without I/O
  private readNext(): void {
    if (this.isReading) {
      return;
    }

    for (let next = this.queue.take(); next !== undefined; next = this.queue.take()) {
      if (this.isCurrent(next)) {
        this.isReading = true;
        void this.read(next);
        return;
      }
    }
  }

  private isCurrent(item: QueueItem<Script>): boolean {
    return item.need === "name"
      ? this.states.get(item.reading.script.url) === item.reading
      : this.search.view(item.script) === "searching";
  }

  // Never rejects: what ends a read is logged, and an unexpected error stops the debugger
  private async read(item: QueueItem<Script>): Promise<void> {
    try {
      const startedMs = performance.now();
      if (item.need === "name") {
        const decoded = await readAndDecode(item.reading.script);
        this.settleName(item.reading, decoded, performance.now() - startedMs);
      } else {
        const found = await readSources(item.script);
        this.settleSearch(item.script, found, performance.now() - startedMs);
      }
    } catch (error) {
      this.dependencies.fail(error);
    } finally {
      this.isReading = false;
      this.readNext();
    }
  }

  private settleName(reading: ReadingState<Script>, decoded: DecodedMap, elapsedMs: number): void {
    const { script } = reading;
    if (this.states.get(script.url) !== reading) {
      this.log("debug", `source map ${describeMap(script)} ignored: its script record is gone`);
      return;
    }

    let isSearchOver: boolean;
    if (decoded.ok) {
      const { sources, index } = decoded.value;
      this.states.set(script.url, { kind: "read", script, sources, index });
      this.log("debug", `source map loaded: ${describeMap(script)}, ${describeRead(decoded.bytes, elapsedMs)}`);
      isSearchOver = this.search.keep(script, sources);
    } else {
      this.states.set(script.url, { kind: "failed", script, failure: decoded });
      this.log("warn", `source map ${describeMap(script)} cannot be used: ${decoded.reason}`);
      isSearchOver = this.search.fail(script, toOverLimitReason(decoded));
    }

    this.dependencies.onRead(script);
    if (isSearchOver) {
      this.endSearch();
    }
  }

  // A map over a limit is worth a warning, since a breakpoint may be in it; any other failure, such as the index map
  // of a bundler's own runtime, is expected while searching
  private settleSearch(script: Script, found: Decoded<Array<MapSource | undefined>>, elapsedMs: number): void {
    if (this.search.view(script) !== "searching") {
      this.log("debug", `source map ${describeMap(script)} ignored: its script record is gone`);
      return;
    }

    let isSearchOver: boolean;
    if (found.ok) {
      this.log("debug", `source map searched: ${describeMap(script)}, ${describeRead(found.bytes, elapsedMs)}`);
      isSearchOver = this.search.keep(script, found.value);
    } else {
      this.log(
        found.isOverLimit ? "warn" : "debug",
        `source map ${describeMap(script)} cannot be searched: ${found.reason}`,
      );
      isSearchOver = this.search.fail(script, toOverLimitReason(found));
    }

    if (isSearchOver) {
      this.endSearch();
    }
  }

  private endSearch(): void {
    this.log("debug", "bundles searched");
    this.dependencies.onSearched();
  }

  private log(level: "debug" | "warn", message: string): void {
    this.dependencies.logger.log(level, message, { component: COMPONENT });
  }
}

const describeRead = (bytes: number, elapsedMs: number): string =>
  `${String(bytes)} bytes, ${String(Math.round(elapsedMs))} ms`;
