import { isRecord } from "../../connector/index.js";
import type { SdkLogger } from "../../logger/index.js";

const COMPONENT = "debugger";

/** The commands the breakpoints send to V8; an `InspectorSession` answers them. */
export interface V8Inspector {
  post(method: string, params?: object): { ok: true; value: object } | { ok: false; error: Error };
}

/** Where V8 put a breakpoint: 1-based line and column, as editors count. */
export interface V8Location {
  url: string;
  line: number;
  column: number;
}

/** A position in a script: 0-based line and column, as V8 and source maps count. */
export interface ScriptPosition {
  line: number;
  column: number;
}

/** The outcome of asking for a V8 breakpoint; `place` identifies it for `release()`. */
export type Acquired = { ok: true; place: string; location: V8Location } | { ok: false; reason: "noCode" | "failed" };

interface Place {
  v8Id: string;
  location: V8Location;
  owners: Set<string>;
}

// V8 answers a breakpoint that found no code with an empty `locations`
const readSetResult = (value: object, url: string): { v8Id: string; location?: V8Location } | undefined => {
  const v8Id: unknown = Reflect.get(value, "breakpointId");
  const locations: unknown = Reflect.get(value, "locations");
  if (typeof v8Id !== "string" || !Array.isArray(locations)) {
    return undefined;
  }

  const first: unknown = locations[0];
  const lineNumber: unknown = isRecord(first) ? Reflect.get(first, "lineNumber") : undefined;
  const columnNumber: unknown = isRecord(first) ? Reflect.get(first, "columnNumber") : undefined;
  if (typeof lineNumber !== "number" || typeof columnNumber !== "number") {
    return { v8Id };
  }

  return { v8Id, location: { url, line: lineNumber + 1, column: columnNumber + 1 } };
};

const readHitBreakpoints = (params: unknown): string[] => {
  const hit: unknown = isRecord(params) ? Reflect.get(params, "hitBreakpoints") : undefined;
  return Array.isArray(hit) ? (hit as unknown[]).filter((id): id is string => typeof id === "string") : [];
};

/**
 * The V8 breakpoints of the entries. Entries that ask for the same URL, line and column share one, which is removed
 * with the last of them. There are at most 100 entries, so at most 100 places.
 */
export class V8Breakpoints {
  private readonly places = new Map<string, Place>();
  private readonly placeByV8Id = new Map<string, string>();

  constructor(
    private readonly session: V8Inspector,
    private readonly logger: SdkLogger,
  ) {}

  /** Sets a breakpoint at `position` (0-based) of the script at `url` for `owner`, or joins the one already there. */
  acquire(owner: string, url: string, position: ScriptPosition): Acquired {
    const { line, column } = position;
    const place = `${String(line)}:${String(column)}:${url}`;
    const existing = this.places.get(place);
    if (existing !== undefined) {
      existing.owners.add(owner);
      return { ok: true, place, location: existing.location };
    }

    // By URL, so V8 also sets it in every later script with this URL, such as a module that is loaded again
    const answer = this.session.post("Debugger.setBreakpointByUrl", { url, lineNumber: line, columnNumber: column });
    const result = answer.ok ? readSetResult(answer.value, url) : undefined;
    if (result === undefined) {
      return { ok: false, reason: "failed" };
    }

    if (result.location === undefined) {
      this.removeFromV8(result.v8Id);
      return { ok: false, reason: "noCode" };
    }

    this.places.set(place, { v8Id: result.v8Id, location: result.location, owners: new Set([owner]) });
    this.placeByV8Id.set(result.v8Id, place);
    return { ok: true, place, location: result.location };
  }

  /** Ends `owner`'s use of `place`; the V8 breakpoint goes with the last owner. */
  release(owner: string, place: string): void {
    const found = this.places.get(place);
    if (found === undefined) {
      return;
    }

    found.owners.delete(owner);
    if (found.owners.size === 0) {
      this.places.delete(place);
      this.placeByV8Id.delete(found.v8Id);
      this.removeFromV8(found.v8Id);
    }
  }

  /** Tells whether one of the `hitBreakpoints` of a `Debugger.paused` event is one of these breakpoints. */
  ownsPause(params: unknown): boolean {
    return readHitBreakpoints(params).some((v8Id) => this.placeByV8Id.has(v8Id));
  }

  /** Forgets every breakpoint without a V8 call, after disabling the domain removed them. */
  forgetAll(): void {
    this.places.clear();
    this.placeByV8Id.clear();
  }

  removeAll(): void {
    for (const { v8Id } of this.places.values()) {
      this.removeFromV8(v8Id);
    }

    this.forgetAll();
  }

  private removeFromV8(v8Id: string): void {
    const removed = this.session.post("Debugger.removeBreakpoint", { breakpointId: v8Id });
    if (!removed.ok) {
      this.logger.log("warn", "could not remove a breakpoint from the inspector", {
        component: COMPONENT,
        error: removed.error,
      });
    }
  }
}
