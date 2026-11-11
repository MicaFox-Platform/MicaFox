import type { Snapshot } from "@micafox/protocol";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

import { Throttle, type ThrottledBreakpoints, type ThrottleInspector } from "./throttle.js";
import type { SdkLogger } from "../../logger/index.js";
import { cutSnapshot, readPause, type PausedLocation, type PauseRead, type SnapshotTarget } from "../capture/index.js";
import type { Admission, RateLimiter } from "../rate-limiter/index.js";
import type { FrameLocation } from "../source-maps/index.js";

const COMPONENT = "debugger";

/** The inspector session as `Pauses` uses it; an `InspectorSession` fits. */
export interface PausesInspector extends ThrottleInspector {
  /** Calls `handler` with the params of every `event`; returns a function that stops it. */
  on(event: string, handler: (params: unknown) => void): () => void;
}

/** What `Pauses` needs from `Breakpoints`. */
export interface PausedBreakpoints extends ThrottledBreakpoints {
  /** The active entries on the V8 breakpoints of a pause, with their limits; empty for a foreign pause. */
  hitEntries(params: unknown): SnapshotTarget[];
  /** Where a paused call frame is shown; never throws. */
  locateFrame(frame: PausedLocation): FrameLocation;
  /** Forgets the V8 breakpoints after `Debugger.disable` turned the domain off. */
  forgetDomain(): void;
}

/** What `Pauses` needs from the debugger. */
export interface PausesDependencies {
  session: PausesInspector;
  logger: SdkLogger;
  breakpoints: PausedBreakpoints;
  limiter: RateLimiter;
  /** Tells whether a name's value is redacted (ADR 0012). */
  isSecret: (name: string) => boolean;
  /** Sends a snapshot to the hub; it never throws. */
  send: (snapshot: Snapshot) => void;
  /** Reports an unexpected error: the debugger stops itself. */
  fail: (error: unknown) => void;
  /** A monotonic clock in milliseconds for the pause budget; defaults to `performance.now()`. */
  now?: () => number;
}

/** What happened inside one pause, before the thread resumed. */
type Inside =
  | { kind: "captured"; admission: Admission; targets: SnapshotTarget[]; read?: PauseRead }
  | { kind: "failed"; error: unknown };

const NOBODY: Admission = { allowed: [], outOfTokens: [] };

/**
 * Handles every `Debugger.paused`: checks the rate limits of the entries hit, reads the pause once for the allowed
 * ones, resumes the thread whatever happens, charges the pause to the budget, then sends one snapshot per allowed
 * entry (docs/architecture/sdk/debugger.md#capturing-a-snapshot). Log lines written during a pause are held.
 */
export class Pauses {
  private readonly throttle: Throttle;
  private readonly now: () => number;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly dependencies: PausesDependencies) {
    this.now = dependencies.now ?? (() => performance.now());
    this.throttle = new Throttle(dependencies);
  }

  /** Listens to `Debugger.paused`; none arrives while the `Debugger` domain is off. */
  start(): void {
    this.unsubscribe = this.dependencies.session.on("Debugger.paused", (params) => {
      this.onPaused(params);
    });
  }

  /** Stops listening and clears the restore timer; call it after `Breakpoints.stop()` turned the domain off. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.throttle.stop();
  }

  // The thread is resumed whatever happens; the work after it runs on a running thread, before the held lines go
  private onPaused(params: unknown): void {
    const startedAt = this.now();
    const inside = this.readInside(params);
    try {
      if (!this.resume()) {
        return;
      }

      const pauseMs = this.now() - startedAt;
      this.dependencies.limiter.charge(pauseMs);
      this.afterResume(inside, pauseMs);
    } catch (error) {
      this.dependencies.fail(error);
    } finally {
      this.dependencies.logger.release();
    }
  }

  private readInside(params: unknown): Inside {
    try {
      this.dependencies.logger.hold();
      const hit = this.dependencies.breakpoints.hitEntries(params);
      if (hit.length === 0) {
        this.log("debug", "resumed a pause that none of the breakpoints caused");
        return { kind: "captured", admission: NOBODY, targets: [] };
      }

      const admission = this.dependencies.limiter.admit(hit.map((target) => target.breakpointId));
      const allowed = new Set(admission.allowed);
      const targets = hit.filter((target) => allowed.has(target.breakpointId));
      if (targets.length === 0) {
        return { kind: "captured", admission, targets };
      }

      const read = readPause(
        params,
        targets.map((target) => target.limits),
        {
          session: this.dependencies.session,
          locateFrame: (frame) => this.dependencies.breakpoints.locateFrame(frame),
          isSecret: this.dependencies.isSecret,
        },
      );
      return { kind: "captured", admission, targets, read };
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  private afterResume(inside: Inside, pauseMs: number): void {
    if (inside.kind === "failed") {
      this.dependencies.fail(inside.error);
      return;
    }

    const { read } = inside;
    if (read !== undefined) {
      for (const target of inside.targets) {
        this.sendSnapshot(cutSnapshot(read, target), pauseMs);
      }
    }

    this.throttle.afterPause(inside.admission.outOfTokens);
  }

  private sendSnapshot(snapshot: Snapshot, pauseMs: number): void {
    this.dependencies.send(snapshot);
    // Serializing a snapshot costs time, so the size is measured only for a line that is written
    if (!this.dependencies.logger.enabled("debug")) {
      return;
    }

    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    const truncated = snapshot.truncated === true;
    this.dependencies.logger.log(
      "debug",
      `snapshot ${snapshot.breakpointId}: paused ${pauseMs.toFixed(1)} ms, ${String(bytes)} bytes, truncated ${String(truncated)}`,
      { component: COMPONENT, breakpointId: snapshot.breakpointId },
    );
  }

  // Disabling the domain resumes the thread and drops every V8 breakpoint, so stopping has nothing left to remove
  private resume(): boolean {
    const { session, breakpoints, fail } = this.dependencies;
    const resumed = session.post("Debugger.resume");
    if (resumed.ok) {
      return true;
    }

    session.post("Debugger.disable");
    breakpoints.forgetDomain();
    fail(resumed.error);
    return false;
  }

  private log(level: "debug", message: string): void {
    this.dependencies.logger.log(level, message, { component: COMPONENT });
  }
}
