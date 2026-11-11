import { isPlaced, type Outcome, type Placed, type ValidEntry } from "./entry.js";
import type { V8Breakpoints } from "./v8-breakpoints.js";
import type { SdkLogger } from "../../logger/index.js";
import { findLocation, type Location, type MappedRecord, type ScriptRegistry } from "../location/index.js";
import type { SourceMaps } from "../source-maps/index.js";

const COMPONENT = "debugger";

const PENDING: Outcome = { status: "pending" };

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

// docs/architecture/sdk/debugger.md#loading-a-source-map: an entry waiting for a map is pending until it is read
/**
 * The outcome of an entry: its V8 breakpoint set with `status` where `findLocation` puts it, holding the map that
 * placed it; pending on the map reads it started; or an error.
 */
export const placeEntry = (context: PlaceContext, request: PlaceRequest): Outcome => {
  const { scripts, sourceMaps } = context;
  const location = findLocation(request.entry, request.segments, {
    findCandidates: (fileName) => scripts.findCandidates(fileName),
    findMapped: (baseName) => scripts.findMapped(baseName),
    viewMap: (script) => sourceMaps.view(script),
  });

  switch (location.kind) {
    case "pending":
      for (const script of location.reads) {
        sourceMaps.load(script);
      }

      return PENDING;
    case "error":
      return location.isRetryable === true
        ? { status: "error", message: location.message, isRetryable: true }
        : { status: "error", message: location.message };
    case "script":
      return setAt(context, request, location);
  }
};

/** Ends an entry's hold on its V8 breakpoint, removed with the last entry on it, and on the map that placed it. */
export const releaseEntry = (context: PlaceContext, id: string, outcome: Outcome): void => {
  if (!isPlaced(outcome)) {
    return;
  }

  context.v8.release(id, outcome.place);
  if (outcome.mapUrl !== undefined) {
    context.sourceMaps.release(outcome.mapUrl, id);
  }
};

/**
 * Sets a rate-limited entry again where it was, joining the V8 breakpoint when other entries still hold it; the map
 * it holds stays held. The script may have changed since, so it can fail.
 */
export const placeAgain = (context: PlaceContext, id: string, placed: Placed): Outcome => {
  const acquired = context.v8.acquire(id, placed.url, placed.position);
  if (acquired.ok) {
    return { ...placed, status: "active" };
  }

  releaseEntry(context, id, { ...placed, status: "rateLimited" });
  const message =
    acquired.reason === "noCode"
      ? "no code at the breakpoint's line any more"
      : "the inspector could not set the breakpoint";
  return { status: "error", message };
};

const setAt = (
  context: PlaceContext,
  request: PlaceRequest,
  location: Extract<Location, { kind: "script" }>,
): Outcome => {
  const { entry, status } = request;
  const acquired = context.v8.acquire(entry.id, location.url, location.position);
  if (!acquired.ok) {
    const message =
      acquired.reason === "noCode"
        ? `no code at or after line ${String(entry.line)}`
        : "the inspector could not set the breakpoint";
    return { status: "error", message };
  }

  const placed = acquired.location;
  context.logger.log(
    "debug",
    `${entry.id} ${entry.file}:${String(entry.line)} → ${placed.url}:${String(placed.line)}:${String(placed.column)}`,
    { component: COMPONENT },
  );
  const where: Placed = { place: acquired.place, url: location.url, position: location.position };
  if (location.mapped === undefined) {
    return { status, ...where };
  }

  context.sourceMaps.hold(location.mapped, entry.id);
  return { status, ...where, mapUrl: location.mapped.url };
};
