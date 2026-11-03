import { PROTOCOL_VERSION, type BreakpointStatus } from "@probex-platform/protocol";

import { isSameEntry, type ListedEntry, type ValidEntry } from "./entry.js";
import { matchScript, type ScriptMatch } from "./match-script.js";
import { readBreakpointList } from "./read-list.js";
import { ScriptRegistry, toSegments } from "./script-registry.js";
import { V8Breakpoints, type V8Inspector } from "./v8-breakpoints.js";
import { isRecord } from "../../connector/index.js";
import type { SdkLogger } from "../../logger/index.js";

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

type Outcome = { status: "pending" } | { status: "active"; place: string } | { status: "error"; message: string };

/** An entry of the latest list and what became of it. */
interface Applied {
  entry: ListedEntry;
  /** The segments of the entry's `file`; empty for an invalid entry. */
  segments: string[];
  outcome: Outcome;
}

const PENDING: Outcome = { status: "pending" };

const toStatus = (breakpointId: string, outcome: Outcome): BreakpointStatus => {
  const base = { version: PROTOCOL_VERSION, type: "breakpointStatus", breakpointId } as const;
  return outcome.status === "error"
    ? { ...base, status: "error", message: outcome.message }
    : { ...base, status: outcome.status };
};

const readHitBreakpoints = (params: unknown): string[] => {
  const hit: unknown = isRecord(params) ? Reflect.get(params, "hitBreakpoints") : undefined;
  return Array.isArray(hit) ? (hit as unknown[]).filter((id): id is string => typeof id === "string") : [];
};

/**
 * The breakpoints the hub listed, set in V8 in the scripts without a source map. Holds the latest list, the status
 * of each entry, and resumes every pause. Time and memory are bounded by the 100 entries it holds and the scripts
 * the app loads while any is set.
 */
export class Breakpoints {
  private readonly applied = new Map<string, Applied>();
  private readonly scripts = new ScriptRegistry();
  private readonly v8: V8Breakpoints;
  private readonly unsubscribes: Array<() => void> = [];
  private isDomainOn = false;
  private isStopped = false;

  constructor(private readonly dependencies: BreakpointsDependencies) {
    this.v8 = new V8Breakpoints(dependencies.session, dependencies.logger);
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

  /** Removes every breakpoint from V8 and turns the `Debugger` domain off; the debugger is stopping. */
  stop(): void {
    this.isStopped = true;
    // The pause handler stays until the domain is off: a warning logged here runs app code, which may pause
    this.v8.removeAll();
    this.applied.clear();
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

  private locate(entry: ValidEntry, segments: readonly string[]): Outcome {
    const fileName = segments.at(-1);
    const match: ScriptMatch =
      fileName === undefined ? { kind: "none" } : matchScript(segments, this.scripts.findCandidates(fileName));

    switch (match.kind) {
      case "none":
        return PENDING;
      case "several":
        return { status: "error", message: "file matches several files" };
      case "one":
        return this.setBreakpoint(entry, match.script.url);
    }
  }

  private setBreakpoint(entry: ValidEntry, url: string): Outcome {
    const acquired = this.v8.acquire(entry.id, url, entry.line);
    if (!acquired.ok) {
      const message =
        acquired.reason === "noCode"
          ? `no code at or after line ${String(entry.line)}`
          : "the inspector could not set the breakpoint";
      return { status: "error", message };
    }

    const { location } = acquired;
    this.log(
      "debug",
      `${entry.id} ${entry.file}:${String(entry.line)} → ${location.url}:${String(location.line)}:${String(location.column)}`,
    );
    return { status: "active", place: acquired.place };
  }

  // A pending entry is resolved again when a script with its file name loads; the new status is sent
  private onScriptParsed(params: unknown): void {
    const fileName = this.scripts.record(params)?.segments.at(-1);
    if (fileName === undefined) {
      return;
    }

    const changed: string[] = [];
    for (const [id, current] of this.applied) {
      if (current.entry.kind !== "valid" || current.outcome.status !== "pending") {
        continue;
      }

      if (current.segments.at(-1) === fileName) {
        const outcome = this.locate(current.entry, current.segments);
        if (outcome.status !== "pending") {
          this.applied.set(id, { ...current, outcome });
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
      if (!this.v8.owns(readHitBreakpoints(params))) {
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
    const counts = { active: 0, pending: 0, error: 0 };
    for (const id of ids) {
      const status = this.applied.get(id)?.outcome.status;
      if (status !== undefined) {
        counts[status] += 1;
      }
    }

    this.log(
      "info",
      `${String(counts.active)} active, ${String(counts.pending)} pending, ${String(counts.error)} error`,
    );
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
