import type { MapSource } from "./map-sources.js";

/** A source a search found and the script whose map holds it. */
export interface SearchedSource<Script> {
  readonly script: Script;
  readonly source: MapSource;
}

/** How far the search of a script's map got: not asked for, queued or reading, or over: read, failed or dropped. */
export type SearchView = "unsearched" | "searching" | "searched";

type SearchState<Script> =
  | { kind: "searching"; script: Script }
  | { kind: "read"; script: Script; fileNames: readonly string[] }
  | { kind: "failed"; script: Script; overLimitReason?: string }
  | { kind: "dropped"; script: Script };

/** The most sources kept across all scripts; a map has at most 50,000, so two maps never fill it alone. */
export const MAX_SEARCHED_SOURCES = 100_000;

/**
 * The sources of the maps read for a search, without those under `node_modules`, by file name, at most 100,000.
 * Past that the oldest script record's sources are dropped, and that record is not searched again until it is
 * recorded again. Holds one state per script record and is dropped with the records.
 */
export class SourceSearch<Script extends { readonly url: string }> {
  private readonly states = new Map<string, SearchState<Script>>();
  private readonly byFileName = new Map<string, Map<string, Array<SearchedSource<Script>>>>();
  private sourceCount = 0;
  private pendingCount = 0;

  /** How far the search of `script`'s map got; a script recorded again under its URL starts unsearched. */
  view(script: Script): SearchView {
    const state = this.states.get(script.url);
    if (state?.script !== script) {
      return "unsearched";
    }

    return state.kind === "searching" ? "searching" : "searched";
  }

  /** Marks the map of `script` as queued for a search; the caller checks first that it is unsearched. */
  start(script: Script): void {
    this.forget(script.url);
    this.states.set(script.url, { kind: "searching", script });
    this.pendingCount += 1;
  }

  /** Whether a search of a map is queued or reading. */
  isSearching(): boolean {
    return this.pendingCount > 0;
  }

  /**
   * Keeps the sources of `script`'s map, from a read for a search or by name, unless the record already has a
   * search over or is gone. Returns whether this ended the last search pending.
   */
  keep(script: Script, sources: ReadonlyArray<MapSource | undefined>): boolean {
    const state = this.states.get(script.url);
    if (state !== undefined && (state.script !== script || state.kind !== "searching")) {
      return false;
    }

    const fileNames = this.index(script, sources);
    this.states.set(script.url, { kind: "read", script, fileNames });
    this.dropOldest(script.url);
    return this.settle(state);
  }

  /**
   * Ends the search of `script`'s map that could not be read, by a search or by name, unless the record already
   * has a search over or is gone; an over-limit reason is given to a searching entry
   * that finds no candidate. Returns whether this ended the last search pending.
   */
  fail(script: Script, overLimitReason: string | undefined): boolean {
    const state = this.states.get(script.url);
    if (state !== undefined && (state.script !== script || state.kind !== "searching")) {
      return false;
    }

    const failed: SearchState<Script> =
      overLimitReason === undefined ? { kind: "failed", script } : { kind: "failed", script, overLimitReason };
    this.states.set(script.url, failed);
    return this.settle(state);
  }

  /** The sources found whose path ends in `fileName`. O(found). */
  find(fileName: string): Array<SearchedSource<Script>> {
    return [...(this.byFileName.get(fileName)?.values() ?? [])].flat();
  }

  /** The reason of the first map over a limit, which a searching entry that finds no candidate gets. O(scripts). */
  failure(): string | undefined {
    for (const state of this.states.values()) {
      if (state.kind === "failed" && state.overLimitReason !== undefined) {
        return state.overLimitReason;
      }
    }

    return undefined;
  }

  /** Forgets the search of the record of `url`. Returns whether this ended the last search pending. */
  forget(url: string): boolean {
    const state = this.states.get(url);
    if (state === undefined) {
      return false;
    }

    this.unindex(state);
    this.states.delete(url);
    return this.settle(state);
  }

  clear(): void {
    this.states.clear();
    this.byFileName.clear();
    this.sourceCount = 0;
    this.pendingCount = 0;
  }

  // A pending search that ended lowers the count; true when it was the last
  private settle(state: SearchState<Script> | undefined): boolean {
    if (state?.kind !== "searching") {
      return false;
    }

    this.pendingCount -= 1;
    return this.pendingCount === 0;
  }

  private index(script: Script, sources: ReadonlyArray<MapSource | undefined>): string[] {
    const fileNames = new Set<string>();
    for (const source of sources) {
      const fileName = source?.segments.at(-1);
      if (source === undefined || source.isDependency || fileName === undefined) {
        continue;
      }

      const byScript = this.byFileName.get(fileName) ?? new Map<string, Array<SearchedSource<Script>>>();
      const found = byScript.get(script.url) ?? [];
      found.push({ script, source });
      byScript.set(script.url, found);
      this.byFileName.set(fileName, byScript);
      fileNames.add(fileName);
      this.sourceCount += 1;
    }

    return [...fileNames];
  }

  private unindex(state: SearchState<Script>): void {
    if (state.kind !== "read") {
      return;
    }

    const { url } = state.script;
    for (const fileName of state.fileNames) {
      const byScript = this.byFileName.get(fileName);
      this.sourceCount -= byScript?.get(url)?.length ?? 0;
      byScript?.delete(url);
      if (byScript?.size === 0) {
        this.byFileName.delete(fileName);
      }
    }
  }

  // The states keep the order the records were first searched in, so the first ones read are the oldest
  private dropOldest(keptUrl: string): void {
    for (const [url, state] of this.states) {
      if (this.sourceCount <= MAX_SEARCHED_SOURCES) {
        return;
      }

      if (url !== keptUrl && state.kind === "read") {
        this.unindex(state);
        this.states.set(url, { kind: "dropped", script: state.script });
      }
    }
  }
}
