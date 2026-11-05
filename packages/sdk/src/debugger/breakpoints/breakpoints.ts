import type { BreakpointStatus } from "@probex-platform/protocol";

import {
  isSameEntry,
  isSameStatus,
  isUnresolved,
  summarizeOutcomes,
  toStatus,
  type ListedEntry,
  type Outcome,
  type ValidEntry,
} from "./entry.js";
import { findLocation, mayResolveTo, type Location } from "./find-location.js";
import { readBreakpointList } from "./read-list.js";
import { ScriptRegistry, isMapped, toSegments, type MappedRecord, type ScriptRecord } from "./script-registry.js";
import { V8Breakpoints, type V8Inspector } from "./v8-breakpoints.js";
import type { SdkLogger } from "../../logger/index.js";
import type { PausedLocation } from "../capture/index.js";
import { SourceMaps, locateFrame, type FrameLocation, type MapView } from "../source-maps/index.js";

const COMPONENT = "debugger";

/** The inspector session as `Breakpoints` uses it; an `InspectorSession` fits. */
export interface BreakpointsInspector extends V8Inspector {
  /** Calls `handler` with the params of every `event`; returns a function that stops it. */
  on(event: string, handler: (params: unknown) => void): () => void;
}

/** What `Breakpoints` needs from the debugger. */
export interface BreakpointsDependencies {
  session: BreakpointsInspector;
  logger: SdkLogger;
  /** Sends a status to the hub; it never throws. */
  send: (status: BreakpointStatus) => void;
  /** Reports an unexpected error from an inspector event: the debugger stops itself. */
  fail: (error: unknown) => void;
}

/** The inspector refused a command the breakpoints cannot work without. */
class BreakpointsError extends Error {
  override readonly name = "BreakpointsError";
}

/** An entry of the latest list and what became of it. */
interface Applied {
  entry: ListedEntry;
  /** The segments of the entry's `file`; empty for an invalid entry. */
  segments: string[];
  outcome: Outcome;
}

const PENDING: Outcome = { status: "pending" };
const UNREAD: MapView = { kind: "unread" };

/**
 * The breakpoints the hub listed, set in V8 in the loaded scripts, through their source maps where they have one.
 * Holds the latest list, the status of each entry, and resumes every pause. Time and memory are bounded by the 100
 * entries it holds and the scripts the app loads while any is set.
 */
export class Breakpoints {
  private readonly applied = new Map<string, Applied>();
  private readonly scripts = new ScriptRegistry();
  private readonly v8: V8Breakpoints;
  private readonly sourceMaps: SourceMaps<MappedRecord>;
  private readonly unsubscribes: Array<() => void> = [];
  private isDomainOn = false;
  private isStopped = false;

  constructor(private readonly dependencies: BreakpointsDependencies) {
    this.v8 = new V8Breakpoints(dependencies.session, dependencies.logger);
    this.sourceMaps = new SourceMaps<MappedRecord>({
      logger: dependencies.logger,
      onRead: (script) => {
        this.guard(() => {
          this.onMapRead(script);
        });
      },
      fail: dependencies.fail,
    });
  }

  /** Listens to the inspector's events; none arrives while the `Debugger` domain is off. */
  start(): void {
    this.isStopped = false;
    this.unsubscribes.push(
      this.dependencies.session.on("Debugger.scriptParsed", (params) => {
        this.guard(() => {
          this.onScriptParsed(params);
        });
      }),
      this.dependencies.session.on("Debugger.paused", (params) => {
        this.onPaused(params);
      }),
    );
  }

  /** Makes the breakpoints match a `breakpoints` message and sends the status of each listed one; may throw. */
  apply(message: unknown): void {
    const list = readBreakpointList(message);
    if (list === undefined) {
      this.log("warn", "breakpoints must be an array; the list was ignored");
      return;
    }

    for (const warning of list.warnings) {
      this.log("warn", warning);
    }

    this.update(list.entries);
    // A handler of an event V8 sent inside a command may have stopped the debugger; that stop logged why
    if (this.isStopped) {
      return;
    }

    const ids = list.entries.map((entry) => entry.id);
    this.logCounts(ids);
    this.report(ids);
  }

  /**
   * Where a paused call frame is shown: the original position where the script's map is decoded, which it is while
   * a breakpoint is set through it, else the script's own path and position. Never throws.
   */
  locateFrame(frame: PausedLocation): FrameLocation {
    const script = this.scripts.findFrameScript(frame.scriptId);
    const view = script?.record !== undefined && isMapped(script.record) ? this.sourceMaps.view(script.record) : UNREAD;
    return locateFrame(script?.url, view, { line: frame.lineNumber, column: frame.columnNumber });
  }

  /** Removes every breakpoint from V8 and turns the `Debugger` domain off; the debugger is stopping. */
  stop(): void {
    this.isStopped = true;
    // The pause handler stays until the domain is off: a warning logged here runs app code, which may pause
    this.v8.removeAll();
    this.applied.clear();
    this.sourceMaps.clear();
    this.turnOff();
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
  }

  // docs/architecture/sdk/debugger.md#applying-breakpoints
  private update(entries: readonly ListedEntry[]): void {
    const next = new Map(entries.map((entry) => [entry.id, entry]));
    for (const [id, current] of this.applied) {
      const replacement = next.get(id);
      if (replacement === undefined || !isSameEntry(current.entry, replacement)) {
        this.drop(id, current);
      }
    }

    // Without an entry to set in V8 the domain is off, also for a list of invalid entries
    if (!entries.some((entry) => entry.kind === "valid")) {
      this.addAll(entries);
      this.turnOff();
      return;
    }

    // Turning the domain on makes V8 report every loaded script, so the entries are resolved after it
    this.turnOn();
    if (!this.isStopped) {
      this.addAll(entries);
    }
  }

  private addAll(entries: readonly ListedEntry[]): void {
    for (const entry of entries) {
      if (!this.applied.has(entry.id)) {
        this.applied.set(entry.id, this.resolve(entry));
      }
    }
  }

  private drop(id: string, current: Applied): void {
    if (current.outcome.status === "active") {
      this.v8.release(id, current.outcome.place);
      if (current.outcome.mapUrl !== undefined) {
        this.sourceMaps.release(current.outcome.mapUrl, id);
      }
    }

    this.applied.delete(id);
  }

  private resolve(entry: ListedEntry): Applied {
    if (entry.kind === "invalid") {
      return { entry, segments: [], outcome: { status: "error", message: entry.message } };
    }

    const segments = toSegments(entry.file);
    return { entry, segments, outcome: this.locate(entry, segments) };
  }

  // docs/architecture/sdk/debugger.md#loading-a-source-map: an entry waiting for a map is pending until it is read
  private locate(entry: ValidEntry, segments: readonly string[]): Outcome {
    const location = findLocation(entry, segments, {
      findCandidates: (fileName) => this.scripts.findCandidates(fileName),
      findMapped: (baseName) => this.scripts.findMapped(baseName),
      viewMap: (script) => this.sourceMaps.view(script),
    });

    switch (location.kind) {
      case "pending":
        for (const script of location.reads) {
          this.sourceMaps.load(script);
        }

        return PENDING;
      case "error":
        return location.isRetryable === true
          ? { status: "error", message: location.message, isRetryable: true }
          : { status: "error", message: location.message };
      case "script":
        return this.setBreakpoint(entry, location);
    }
  }

  private setBreakpoint(entry: ValidEntry, location: Extract<Location, { kind: "script" }>): Outcome {
    const acquired = this.v8.acquire(entry.id, location.url, location.position);
    if (!acquired.ok) {
      const message =
        acquired.reason === "noCode"
          ? `no code at or after line ${String(entry.line)}`
          : "the inspector could not set the breakpoint";
      return { status: "error", message };
    }

    const placed = acquired.location;
    this.log(
      "debug",
      `${entry.id} ${entry.file}:${String(entry.line)} → ${placed.url}:${String(placed.line)}:${String(placed.column)}`,
    );
    if (location.mapped === undefined) {
      return { status: "active", place: acquired.place };
    }

    this.sourceMaps.hold(location.mapped, entry.id);
    return { status: "active", place: acquired.place, mapUrl: location.mapped.url };
  }

  // A pending entry is resolved again when a script it may resolve to loads; the new status is sent
  private onScriptParsed(params: unknown): void {
    const script = this.scripts.record(params);
    if (script !== undefined) {
      // A script with the URL of a recorded one replaces it, so the map read for the old one no longer applies
      this.sourceMaps.forget(script.url);
      this.resolvePending(script);
    }
  }

  // The entries waiting for this map are resolved again; then its index is dropped unless one of them holds it
  private onMapRead(script: MappedRecord): void {
    if (this.isStopped) {
      return;
    }

    this.resolvePending(script);
    this.sourceMaps.trim(script);
  }

  private resolvePending(script: ScriptRecord): void {
    const changed: string[] = [];
    for (const [id, current] of this.applied) {
      if (current.entry.kind !== "valid" || !isUnresolved(current.outcome)) {
        continue;
      }

      if (mayResolveTo(current.segments.at(-1), script)) {
        const outcome = this.locate(current.entry, current.segments);
        this.applied.set(id, { ...current, outcome });
        if (!isSameStatus(current.outcome, outcome)) {
          changed.push(id);
        }
      }
    }

    this.report(changed);
  }

  // Held lines are written after the pause, and the thread is resumed whatever happens; if resuming fails,
  // disabling the domain resumes it and the debugger stops itself
  private onPaused(params: unknown): void {
    try {
      this.dependencies.logger.hold();
      if (!this.v8.ownsPause(params)) {
        this.log("debug", "resumed a pause that none of the breakpoints caused");
      }
    } catch (error) {
      this.dependencies.fail(error);
    } finally {
      try {
        this.resume();
      } finally {
        this.dependencies.logger.release();
      }
    }
  }

  // Disabling the domain resumes the thread and drops every V8 breakpoint, so stopping has nothing left to remove
  private resume(): void {
    const resumed = this.dependencies.session.post("Debugger.resume");
    if (resumed.ok) {
      return;
    }

    this.dependencies.session.post("Debugger.disable");
    this.v8.forgetAll();
    this.scripts.clear();
    this.sourceMaps.clear();
    this.isDomainOn = false;
    this.dependencies.fail(resumed.error);
  }

  private turnOn(): void {
    if (this.isDomainOn) {
      return;
    }

    const enabled = this.dependencies.session.post("Debugger.enable");
    if (!enabled.ok) {
      throw new BreakpointsError("the inspector could not turn the Debugger domain on", { cause: enabled.error });
    }

    // Stopped by a scriptParsed handler during the command: the session is disconnected and the domain with it
    if (this.isStopped) {
      return;
    }

    this.isDomainOn = true;
    this.log("debug", "Debugger domain on");
  }

  // V8 reports every loaded script again when the domain is turned on, so the records are dropped. When disabling
  // fails the domain is still on and keeps its scripts, so the next list does not turn it on again
  private turnOff(): void {
    if (!this.isDomainOn) {
      return;
    }

    const disabled = this.dependencies.session.post("Debugger.disable");
    if (!disabled.ok) {
      this.dependencies.logger.log("warn", "the inspector could not turn the Debugger domain off", {
        component: COMPONENT,
        error: disabled.error,
      });
      return;
    }

    this.scripts.clear();
    this.sourceMaps.clear();
    this.isDomainOn = false;
    this.log("debug", "Debugger domain off");
  }

  private report(ids: readonly string[]): void {
    for (const id of ids) {
      const current = this.applied.get(id);
      if (current !== undefined) {
        this.dependencies.send(toStatus(id, current.outcome));
      }
    }
  }

  private logCounts(ids: readonly string[]): void {
    const outcomes = ids.flatMap((id) => this.applied.get(id)?.outcome ?? []);
    this.log("info", summarizeOutcomes(outcomes));
  }

  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.dependencies.fail(error);
    }
  }

  private log(level: "debug" | "info" | "warn", message: string): void {
    this.dependencies.logger.log(level, message, { component: COMPONENT });
  }
}
