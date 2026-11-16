import type { BreakpointStatus } from "@micafox/protocol";

import { DebuggerDomain, type DomainInspector } from "./domain.js";
import {
  diffList,
  keepsDomainOn,
  summarizeOutcomes,
  toStatus,
  type Applied,
  type ListedEntry,
  type Outcome,
  type Placed,
} from "./entry.js";
import { placeAgain, releaseEntry, takeOff, type PlaceContext } from "./place-entry.js";
import { readBreakpointList } from "./read-list.js";
import {
  extendRestored,
  isWaitingForReads,
  resolveEntry,
  resolveOnMapRead,
  resolveOnScript,
  resolveOnSearched,
  type Changes,
  type ResolveState,
} from "./resolve-again.js";
import { V8Breakpoints } from "./v8-breakpoints.js";
import type { SdkLogger } from "../../logger/index.js";
import type { PausedLocation, SnapshotTarget } from "../capture/index.js";
import { Expiry } from "../expiry/index.js";
import { isMapped, type MappedRecord, type ScriptRecord } from "../location/index.js";
import { SourceMaps, locateFrame, type FrameLocation, type MapView } from "../source-maps/index.js";

const COMPONENT = "debugger";

/** What `Breakpoints` needs from the debugger. */
export interface BreakpointsDependencies {
  /** The inspector session; an `InspectorSession` fits. */
  session: DomainInspector;
  logger: SdkLogger;
  /** Sends a status to the hub; it never throws. */
  send: (status: BreakpointStatus) => void;
  /** Reports an unexpected error from an inspector event: the debugger stops itself. */
  fail: (error: unknown) => void;
  /** Called with the id of an entry the latest list no longer has. */
  onRemoved: (id: string) => void;
  /** The monotonic clock in milliseconds, such as `performance.now()`: the entries' time left counts down on it. */
  now: () => number;
}

const UNREAD: MapView = { kind: "unread" };
const EXPIRED: Outcome = { status: "expired" };

/**
 * The breakpoints the hub listed, set in V8 in the loaded scripts, through their source maps where they have one.
 * Holds the latest list and the status of each entry, tells which entries a pause hit, and takes entries off and
 * sets them again for the rate limits. Time and memory are bounded by the 100 entries it holds and the scripts the
 * app loads while any is set.
 */
export class Breakpoints {
  private readonly applied = new Map<string, Applied>();
  private readonly domain: DebuggerDomain;
  private readonly v8: V8Breakpoints;
  private readonly sourceMaps: SourceMaps<MappedRecord>;
  private readonly placing: PlaceContext;
  private readonly expiry: Expiry;
  private isStopped = false;
  /**
   * Every breakpoint is off in V8 for the process's rate limit, so a newly set entry is `rateLimited`. The domain
   * going off does not end it: V8 keeps `setBreakpointsActive(false)` across `Debugger.disable` and `enable`, so
   * only `restore(..., "all")` does, once the throttle turned the breakpoints on again.
   */
  private areAllRateLimited = false;

  constructor(private readonly dependencies: BreakpointsDependencies) {
    this.v8 = new V8Breakpoints(dependencies.session, dependencies.logger);
    this.sourceMaps = new SourceMaps<MappedRecord>({
      logger: dependencies.logger,
      onRead: (script) => {
        this.guard(() => {
          this.onMapRead(script);
        });
      },
      onSearched: () => {
        this.guard(() => {
          this.onSearched();
        });
      },
      fail: dependencies.fail,
    });
    this.domain = new DebuggerDomain({
      session: dependencies.session,
      logger: dependencies.logger,
      isStopped: () => this.isStopped,
      onScript: (script) => {
        this.onScript(script);
      },
      onCleared: () => {
        this.sourceMaps.clear();
      },
      fail: dependencies.fail,
    });
    this.placing = {
      scripts: this.domain.scripts,
      sourceMaps: this.sourceMaps,
      v8: this.v8,
      logger: dependencies.logger,
    };
    this.expiry = new Expiry({
      now: dependencies.now,
      onDue: (ids) => {
        this.onExpired(ids);
      },
      fail: dependencies.fail,
    });
  }

  /** Listens to the inspector's events; none arrives while the `Debugger` domain is off. */
  start(): void {
    this.isStopped = false;
    this.domain.listen();
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

    this.update(list.entries, this.dependencies.now());
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
    const script = this.domain.scripts.findFrameScript(frame.scriptId);
    const view = script?.record !== undefined && isMapped(script.record) ? this.sourceMaps.view(script.record) : UNREAD;
    return locateFrame(script?.url, view, { line: frame.lineNumber, column: frame.columnNumber });
  }

  /** The active entries on the V8 breakpoints of a `Debugger.paused` event, with their limits; empty for a foreign one. */
  hitEntries(params: unknown): SnapshotTarget[] {
    return this.v8.ownersHit(params).flatMap((id) => {
      const current = this.applied.get(id);
      if (current?.entry.kind !== "valid" || current.outcome.status !== "active") {
        return [];
      }

      const { limits } = current.entry;
      return [limits === undefined ? { breakpointId: id } : { breakpointId: id, limits }];
    });
  }

  /** Takes active entries off their V8 breakpoints, removed with the last of them, and sends `rateLimited`. */
  rateLimit(ids: readonly string[]): void {
    this.setRateLimited(ids, (id, outcome) => {
      takeOff(this.placing, id, outcome);
    });
  }

  /** Marks every active entry `rateLimited`, also those set later; their V8 breakpoints stay, turned off in V8. */
  rateLimitAll(): void {
    this.areAllRateLimited = true;
    this.setRateLimited([...this.applied.keys()], () => undefined);
  }

  /** Whether every breakpoint is off for the process's rate limit. */
  isAllRateLimited(): boolean {
    return this.areAllRateLimited;
  }

  /** The entries with status `rateLimited`. */
  rateLimitedIds(): string[] {
    return [...this.applied].flatMap(([id, current]) => (current.outcome.status === "rateLimited" ? [id] : []));
  }

  /**
   * Sets `rateLimited` entries again where they were and sends their status; `all` ends `rateLimitAll()`. Returns
   * the entries that are `active` again; one whose line has no code any more gets `error`.
   */
  restore(ids: readonly string[], scope: "entries" | "all"): string[] {
    this.areAllRateLimited &&= scope !== "all";

    const restored: string[] = [];
    for (const id of ids) {
      const current = this.applied.get(id);
      if (current?.outcome.status === "rateLimited") {
        this.applied.set(id, { ...current, outcome: placeAgain(this.placing, id, current.outcome) });
        restored.push(id);
      }
    }

    // A chunk with the entry's file may have loaded while it was off its V8 breakpoints
    this.commit(extendRestored(this.resolving(), restored));
    this.report(restored);
    return restored.filter((id) => this.applied.get(id)?.outcome.status === "active");
  }

  /** Forgets the V8 breakpoints and scripts after `Debugger.disable` turned the domain off from outside. */
  forgetDomain(): void {
    this.v8.forgetAll();
    this.domain.forget();
  }

  /** Removes every breakpoint from V8 and turns the `Debugger` domain off; the debugger is stopping. */
  stop(): void {
    this.isStopped = true;
    // The pause handler stays until the domain is off: a warning logged here runs app code, which may pause
    this.v8.removeAll();
    this.applied.clear();
    this.expiry.clear();
    this.sourceMaps.clear();
    this.domain.turnOff();
    this.domain.stopListening();
  }

  // docs/architecture/sdk/debugger.md#applying-breakpoints
  private update(entries: readonly ListedEntry[], arrivedAt: number): void {
    for (const { id, current, isRemoved } of diffList(this.applied, entries)) {
      this.drop(id, current);
      if (isRemoved) {
        this.dependencies.onRemoved(id);
      }
    }

    // Without an entry to set in V8 the domain is off, also for a list of invalid or expired entries
    const isLive = entries.some((entry) => keepsDomainOn(entry, this.applied.get(entry.id)?.outcome));
    if (isLive) {
      // Turning the domain on makes V8 report every loaded script, so the entries are resolved after it
      this.domain.turnOn();
      if (this.isStopped) {
        return;
      }
    }

    this.addAll(entries);
    this.setDeadlines(entries, arrivedAt);
    if (!isLive) {
      this.domain.turnOff();
    }
  }

  private addAll(entries: readonly ListedEntry[]): void {
    for (const entry of entries) {
      if (!this.applied.has(entry.id)) {
        // An entry with no time left is never set in V8
        const isOver = entry.kind === "valid" && entry.expiresInMs === 0;
        this.applied.set(
          entry.id,
          isOver ? { entry, segments: [], outcome: EXPIRED } : resolveEntry(this.resolving(), entry),
        );
      }
    }
  }

  // Each list sets the deadline of its entries again, to extend or to shorten it; no V8 call
  private setDeadlines(entries: readonly ListedEntry[], arrivedAt: number): void {
    for (const entry of entries) {
      if (entry.kind !== "valid" || this.applied.get(entry.id)?.outcome.status === "expired") {
        continue;
      }

      if (entry.expiresInMs === 0) {
        this.expire(entry.id);
      } else {
        this.expiry.set(entry.id, arrivedAt + entry.expiresInMs);
      }
    }

    this.expiry.schedule();
  }

  private drop(id: string, current: Applied): void {
    releaseEntry(this.placing, id, current.outcome);
    this.expiry.delete(id);
    this.applied.delete(id);
  }

  // The entry loses its V8 breakpoint and its hold on a source map; it stays in the list as expired
  private expire(id: string): void {
    const current = this.applied.get(id);
    if (current !== undefined && current.outcome.status !== "expired") {
      releaseEntry(this.placing, id, current.outcome);
      this.expiry.delete(id);
      this.applied.set(id, { ...current, outcome: EXPIRED });
    }
  }

  // The timer: with the last live entry gone the domain goes off, so V8 runs the app as if MicaFox were not there
  private onExpired(ids: readonly string[]): void {
    for (const id of ids) {
      this.expire(id);
    }

    this.report(ids);
    this.log("info", `breakpoints expired: ${String(ids.length)}`);
    if (![...this.applied.values()].some(({ entry, outcome }) => keepsDomainOn(entry, outcome))) {
      this.domain.turnOff();
    }
  }

  private setRateLimited(ids: readonly string[], takeOff: (id: string, outcome: Placed) => void): void {
    const limited: string[] = [];
    for (const id of ids) {
      const current = this.applied.get(id);
      if (current?.outcome.status === "active") {
        takeOff(id, current.outcome);
        this.applied.set(id, { ...current, outcome: { ...current.outcome, status: "rateLimited" } });
        limited.push(id);
      }
    }

    this.report(limited);
  }

  // docs/architecture/sdk/debugger.md#applying-breakpoints, step 7. A script with the URL of a recorded one
  // replaces it, so what was read of the old one no longer applies
  private onScript(script: ScriptRecord): void {
    this.sourceMaps.forget(script.url);
    this.commit(resolveOnScript(this.resolving(), script));
  }

  // The entries waiting for this map are resolved again. Indexes no entry holds are dropped once none waits for a
  // read: an entry that waits for several maps needs the ones already read until the last arrives
  private onMapRead(script: MappedRecord): void {
    if (this.isStopped) {
      return;
    }

    this.commit(resolveOnMapRead(this.resolving(), script));
    if (!isWaitingForReads(this.applied)) {
      this.sourceMaps.trimUnheld();
    }
  }

  private onSearched(): void {
    if (!this.isStopped) {
      this.commit(resolveOnSearched(this.resolving()));
    }
  }

  private resolving(): ResolveState {
    return { applied: this.applied, placing: this.placing, areAllRateLimited: this.areAllRateLimited };
  }

  private commit(changes: Changes): void {
    for (const [id, applied] of changes.applied) {
      this.applied.set(id, applied);
    }

    this.report(changes.changed);
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
