import { isPlaced, type Outcome, type Placed, type Placement, type ValidEntry } from "./entry.js";
import type { V8Breakpoints } from "./v8-breakpoints.js";
import type { SdkLogger } from "../../logger/index.js";
import {
  findAddedTargets,
  findLocation,
  type LocationContext,
  type MappedRecord,
  type ScriptRegistry,
  type Target,
} from "../location/index.js";
import type { SourceMaps } from "../source-maps/index.js";

const COMPONENT = "debugger";

const OVER_MEMORY = "source maps of breakpoints over the memory limit";
const INSPECTOR_FAILED = "the inspector could not set the breakpoint";

/** An entry to place: `segments` split from its `file`, and the status it gets once set. */
export interface PlaceRequest {
  entry: ValidEntry;
  segments: readonly string[];
  status: "active" | "rateLimited";
}

/** What placing an entry works with; `Breakpoints` owns all of it. */
export interface PlaceContext {
  scripts: ScriptRegistry;
  sourceMaps: SourceMaps<MappedRecord>;
  v8: V8Breakpoints;
  logger: SdkLogger;
}

type PlacedOutcome = Extract<Outcome, Placed>;

const toLocationContext = ({ scripts, sourceMaps }: PlaceContext): LocationContext => ({
  findCandidates: (fileName) => scripts.findCandidates(fileName),
  findMapped: (baseName) => scripts.findMapped(baseName),
  listSearchable: () => scripts.listSearchable(),
  viewMap: (script) => sourceMaps.view(script),
  searchView: (script) => sourceMaps.searchView(script),
  findSearched: (fileName) => sourceMaps.findSearched(fileName),
  isSearching: () => sourceMaps.isSearching(),
  searchFailure: () => sourceMaps.searchFailure(),
});

const mappedOf = (targets: readonly Target[]): MappedRecord[] =>
  targets.flatMap((target) => (target.mapped === undefined ? [] : [target.mapped]));

const releasePlacement = (context: PlaceContext, id: string, placement: Placement): void => {
  context.v8.release(id, placement.place);
  if (placement.mapUrl !== undefined) {
    context.sourceMaps.release(placement.mapUrl, id);
  }
};

/**
 * Sets `entry`'s V8 breakpoint at each target and holds the maps that placed them. Targets with no code are left
 * out; when the inspector refuses one, what was set is released. The held maps are checked against their limit
 * once, before any V8 call.
 */
const acquireAll = (
  context: PlaceContext,
  entry: ValidEntry,
  targets: readonly Target[],
): { placements: Placement[] } | { message: string } => {
  if (!context.sourceMaps.canHold(mappedOf(targets))) {
    return { message: OVER_MEMORY };
  }

  const placements: Placement[] = [];
  for (const target of targets) {
    const acquired = context.v8.acquire(entry.id, target.url, target.position);
    if (!acquired.ok && acquired.reason === "failed") {
      for (const placement of placements) {
        releasePlacement(context, entry.id, placement);
      }

      return { message: INSPECTOR_FAILED };
    }

    if (acquired.ok) {
      const { location } = acquired;
      const where = `${location.url}:${String(location.line)}:${String(location.column)}`;
      context.logger.log("debug", `${entry.id} ${entry.file}:${String(entry.line)} → ${where}`, {
        component: COMPONENT,
      });
      const placement: Placement = { place: acquired.place, url: target.url, position: target.position };
      if (target.mapped !== undefined) {
        context.sourceMaps.hold(target.mapped, entry.id);
        placement.mapUrl = target.mapped.url;
      }

      placements.push(placement);
    }
  }

  return { placements };
};

const setAt = (
  context: PlaceContext,
  request: PlaceRequest,
  location: { targets: readonly Target[]; winningPath?: string },
): Outcome => {
  const { entry, status } = request;
  const { winningPath } = location;
  const acquired = acquireAll(context, entry, location.targets);
  if ("message" in acquired) {
    return { status: "error", message: acquired.message };
  }

  if (acquired.placements.length === 0) {
    return { status: "error", message: `no code at or after line ${String(entry.line)}` };
  }

  const { placements } = acquired;
  return winningPath === undefined ? { status, placements } : { status, placements, winningPath };
};

// docs/architecture/sdk/debugger.md#loading-a-source-map: an entry waiting for a map is pending until it is read
/**
 * The outcome of an entry: its V8 breakpoints set with `status` where `findLocation` puts them, holding the maps
 * that placed them; pending on the map reads and searches it started; or an error.
 */
export const placeEntry = (context: PlaceContext, request: PlaceRequest): Outcome => {
  const { sourceMaps } = context;
  const location = findLocation(request.entry, request.segments, toLocationContext(context));

  switch (location.kind) {
    case "pending":
      for (const script of location.reads) {
        sourceMaps.load(script);
      }

      for (const script of location.searches ?? []) {
        sourceMaps.searchMap(script);
      }

      return {
        status: "pending",
        waitsFor: location.reads.map((script) => script.url),
        isSearching: location.searches !== undefined,
      };
    case "error":
      return location.isRetryable === true
        ? { status: "error", message: location.message, isRetryable: true, isSearching: location.isSearching === true }
        : { status: "error", message: location.message };
    case "scripts":
      return setAt(context, request, location);
  }
};

/** Ends an entry's hold on its V8 breakpoints, removed with the last entry on each, and on the maps that placed them. */
export const releaseEntry = (context: PlaceContext, id: string, outcome: Outcome): void => {
  if (!isPlaced(outcome)) {
    return;
  }

  for (const placement of outcome.placements) {
    releasePlacement(context, id, placement);
  }
};

/** Takes a rate-limited entry off its V8 breakpoints, removed with the last entry on each; the maps stay held. */
export const takeOff = (context: PlaceContext, id: string, placed: Placed): void => {
  for (const { place } of placed.placements) {
    context.v8.release(id, place);
  }
};

/**
 * Sets a rate-limited entry again where it was, joining the V8 breakpoints other entries still hold; the maps it
 * holds stay held. The scripts may have changed since: a placement with no code any more is dropped, and the entry
 * fails when none is left or the inspector refuses one.
 */
export const placeAgain = (context: PlaceContext, id: string, placed: Placed): Outcome => {
  const kept: Placement[] = [];
  for (const placement of placed.placements) {
    const acquired = context.v8.acquire(id, placement.url, placement.position);
    if (acquired.ok) {
      kept.push({ ...placement, place: acquired.place });
    } else if (acquired.reason === "noCode") {
      releasePlacement(context, id, placement);
    } else {
      releaseEntry(context, id, { ...placed, placements: [...kept, placement], status: "active" });
      return { status: "error", message: INSPECTOR_FAILED };
    }
  }

  return kept.length === 0
    ? { status: "error", message: "no code at the breakpoint's line any more" }
    : { ...placed, placements: kept, status: "active" };
};

/**
 * Also sets an entry a search set in the scripts loaded since whose maps hold its winning path; those whose maps are
 * unread by name are read, and `extending` lists them. Only an entry whose V8 breakpoints are set is extended.
 */
export const extendEntry = (context: PlaceContext, entry: ValidEntry, current: PlacedOutcome): PlacedOutcome => {
  const { winningPath } = current;
  if (winningPath === undefined) {
    return current;
  }

  const tried = current.tried ?? [];
  const urls = new Set([...current.placements.map((placement) => placement.url), ...tried]);
  const added = findAddedTargets(entry, { winningPath, urls }, toLocationContext(context));
  for (const script of added.reads) {
    context.sourceMaps.load(script);
  }

  const extending = added.reads.map((script) => script.url);
  const acquired = added.targets.length === 0 ? { placements: [] } : acquireAll(context, entry, added.targets);
  if ("message" in acquired) {
    context.logger.log("debug", `${entry.id} not set in a later chunk: ${acquired.message}`, { component: COMPONENT });
  }

  const placements = "message" in acquired ? [] : acquired.placements;
  const placedUrls = new Set(placements.map((placement) => placement.url));
  // An inspector failure may pass, so only targets V8 had no code for are not tried again
  const unplaced =
    "message" in acquired ? [] : added.targets.map(({ url }) => url).filter((url) => !placedUrls.has(url));
  return {
    ...current,
    placements: [...current.placements, ...placements],
    extending,
    tried: [...tried, ...added.withoutCode, ...unplaced],
  };
};

/**
 * Drops the placements of an entry made through the map of a script recorded again under `url`: their positions
 * belong to the old script. An entry left with none becomes pending, to be resolved again.
 */
export const dropReplaced = (
  context: PlaceContext,
  current: PlacedOutcome,
  replaced: { id: string; url: string },
): Outcome => {
  const { id, url } = replaced;
  const isReplaced = (placement: Placement): boolean => placement.mapUrl === url;
  // A script recorded again may have code where its predecessor had none
  const tried = current.tried?.filter((tried) => tried !== url);
  const withTried: PlacedOutcome = tried === undefined ? current : { ...current, tried };
  if (!current.placements.some(isReplaced)) {
    return withTried;
  }

  for (const placement of current.placements.filter(isReplaced)) {
    releasePlacement(context, id, placement);
  }

  const kept = current.placements.filter((placement) => !isReplaced(placement));
  return kept.length === 0 ? { status: "pending" } : { ...withTried, placements: kept };
};
