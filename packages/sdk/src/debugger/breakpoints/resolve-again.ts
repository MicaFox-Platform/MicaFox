import {
  isPlaced,
  isSameStatus,
  isUnresolved,
  type Applied,
  type ListedEntry,
  type Outcome,
  type Placed,
} from "./entry.js";
import { dropReplaced, extendEntry, placeEntry, type PlaceContext } from "./place-entry.js";
import { isSearchable, mayResolveTo, toSegments, type MappedRecord, type ScriptRecord } from "../location/index.js";

/** What resolving entries again reads: the entries `Breakpoints` applied, and where they are set. */
export interface ResolveState {
  applied: ReadonlyMap<string, Applied>;
  placing: PlaceContext;
  /** Every breakpoint is off for the process's rate limit: a newly set entry is `rateLimited`, its V8 breakpoints set. */
  areAllRateLimited: boolean;
}

/** What resolving again changed: the new state of each entry it touched, and the entries whose status changed. */
export interface Changes {
  applied: Map<string, Applied>;
  changed: string[];
}

type PlacedOutcome = Extract<Outcome, Placed>;

const isSearching = (outcome: Outcome): boolean =>
  (outcome.status === "pending" || outcome.status === "error") && outcome.isSearching === true;

const isWaitingFor = (outcome: Outcome, url: string): boolean =>
  outcome.status === "pending" && outcome.waitsFor?.includes(url) === true;

/** Whether an entry is pending on the read of a map by name. */
export const isWaitingForReads = (applied: ReadonlyMap<string, Applied>): boolean =>
  [...applied.values()].some(({ outcome }) => outcome.status === "pending" && (outcome.waitsFor?.length ?? 0) > 0);

/** The outcome of an entry the list added or changed: set in V8, pending on map reads, or an error. */
export const resolveEntry = (state: ResolveState, entry: ListedEntry): Applied => {
  if (entry.kind === "invalid") {
    return { entry, segments: [], outcome: { status: "error", message: entry.message } };
  }

  const segments = toSegments(entry.file);
  const status = state.areAllRateLimited ? "rateLimited" : "active";
  return { entry, segments, outcome: placeEntry(state.placing, { entry, segments, status }) };
};

/** The unresolved entries to resolve again, and the outcome they had before a step that left them pending. */
interface Pick {
  isWanted: (id: string, current: Applied) => boolean;
  before?: ReadonlyMap<string, Outcome>;
}

// The status of an entry that differs from the one it had before, else from its current one, is sent
const resolveWhere = (state: ResolveState, working: Changes, pick: Pick): void => {
  const { isWanted, before } = pick;
  for (const [id, current] of working.applied) {
    if (current.entry.kind === "valid" && isUnresolved(current.outcome) && isWanted(id, current)) {
      const resolved = resolveEntry(state, current.entry);
      working.applied.set(id, resolved);
      if (!isSameStatus(before?.get(id) ?? current.outcome, resolved.outcome)) {
        working.changed.push(id);
      }
    }
  }
};

// Only entries whose V8 breakpoints are set: one off for its own rate limit is extended when it is restored
const extendWhere = (
  state: ResolveState,
  working: Changes,
  isWanted: (id: string, outcome: PlacedOutcome) => boolean,
): void => {
  for (const [id, current] of working.applied) {
    const { entry, outcome } = current;
    const isSet = outcome.status === "active" || (outcome.status === "rateLimited" && state.areAllRateLimited);
    if (entry.kind === "valid" && isSet && isWanted(id, outcome)) {
      working.applied.set(id, { ...current, outcome: extendEntry(state.placing, entry, outcome) });
    }
  }
};

// Up to 100 entries are copied, so each step sees what the steps before it changed
const startChanges = (state: ResolveState): Changes => ({ applied: new Map(state.applied), changed: [] });

/** Whether every script with a map that loads is searched: an entry searches the bundles or a search set it. */
export const isSearchWanted = (applied: ReadonlyMap<string, Applied>): boolean => {
  for (const { outcome } of applied.values()) {
    if (isSearching(outcome) || (isPlaced(outcome) && outcome.winningPath !== undefined)) {
      return true;
    }
  }

  return false;
};

/**
 * A script was recorded: placements made through the map of an earlier record of its URL are dropped, an entry
 * left with none is resolved again, and so is every pending entry that may resolve to the script. The map of a
 * searchable script is searched while a search is wanted.
 */
export const resolveOnScript = (state: ResolveState, script: ScriptRecord): Changes => {
  const working = startChanges(state);
  const dropped = new Map<string, Outcome>();
  for (const [id, current] of working.applied) {
    if (isPlaced(current.outcome)) {
      const outcome = dropReplaced(state.placing, current.outcome, { id, url: script.url });
      working.applied.set(id, { ...current, outcome });
      if (!isPlaced(outcome)) {
        dropped.set(id, current.outcome);
      }
    }
  }

  if (isSearchable(script) && isSearchWanted(state.applied)) {
    state.placing.sourceMaps.searchMap(script);
  }

  const isMatch = (current: Applied): boolean => mayResolveTo(current.segments.at(-1), script);
  resolveWhere(state, working, { isWanted: (id, current) => dropped.has(id) || isMatch(current), before: dropped });
  return working;
};

/**
 * The read by name of `script`'s map ended: the entries that wait for it, by name or as a winner of a search, are
 * resolved again, and those a search set and that wait for it to be set in it too are extended.
 */
export const resolveOnMapRead = (state: ResolveState, script: MappedRecord): Changes => {
  const working = startChanges(state);
  resolveWhere(state, working, {
    isWanted: (_id, { segments, outcome }) =>
      mayResolveTo(segments.at(-1), script) || isWaitingFor(outcome, script.url),
  });
  extendWhere(state, working, (_id, outcome) => outcome.extending?.includes(script.url) === true);
  return working;
};

/** The last search read ended: searching entries are resolved again, and those a search set are extended. */
export const resolveOnSearched = (state: ResolveState): Changes => {
  const working = startChanges(state);
  resolveWhere(state, working, { isWanted: (_id, { outcome }) => isSearching(outcome) });
  extendWhere(state, working, (_id, outcome) => outcome.winningPath !== undefined);
  return working;
};

/** Entries set again after a rate limit are also set in the chunks with their file that loaded meanwhile. */
export const extendRestored = (state: ResolveState, ids: readonly string[]): Changes => {
  const working = startChanges(state);
  const isRestored = new Set(ids);
  extendWhere(state, working, (id, outcome) => isRestored.has(id) && outcome.winningPath !== undefined);
  return working;
};
