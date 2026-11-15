import type { CaptureLimits, StackFrame, Value, Variable } from "@micafox/protocol";
import { performance } from "node:perf_hooks";

import { CaptureBudget, DEFAULT_BUDGET, type BudgetLimits } from "./budget.js";
import { largestLimits } from "./limits.js";
import { ValueReader, type CaptureInspector, type Listed } from "./read-value.js";
import { readRemoteObject, type Property, type RemoteObject } from "./remote-object.js";
import { isRecord } from "../../connector/index.js";
import type { FrameLocation } from "../source-maps/index.js";

/** The most frames of a stack a snapshot keeps. */
const MAX_FRAMES = 20;

// local, block, catch, with, eval, closure and module hold the variables of the app; global and script hold the
// globals, which a snapshot leaves out
const SCOPE_TYPES = new Set(["local", "block", "catch", "with", "eval", "closure", "module"]);

/** Where a call frame is paused, as V8 reports it: a script id, and a 0-based line and column. */
export interface PausedLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

/** The clock of a capture: milliseconds that only grow, for the time limit, and the time of day for `time`. */
export interface CaptureClock {
  now: () => number;
  epochMs: () => number;
}

/** What `readPause` needs from the debugger. */
export interface CaptureDependencies {
  session: CaptureInspector;
  /** Where a call frame is shown, through the script's source map where it is decoded; never throws. */
  locateFrame: (frame: PausedLocation) => FrameLocation;
  /**
   * Tells whether the value under a variable, property or string map key of this name is replaced with `redacted`
   * and never read (ADR 0012). Required, so a capture cannot leak by leaving the rules out.
   */
  isSecret: (name: string) => boolean;
  /** Defaults to `performance.now()` and `Date.now()`. */
  clock?: CaptureClock;
  /** Defaults to 10 ms and 64 KiB. */
  budget?: BudgetLimits;
}

/** What one pause gave, read once within the largest limits of the breakpoints that were hit. */
export interface PauseRead {
  /** Milliseconds since the Unix epoch. */
  time: number;
  stack: StackFrame[];
  variables: Variable[];
  /** Whether the time or size limit left values unread. */
  truncated: boolean;
}

/** The pause carries no call frame to read. */
export class CaptureError extends Error {
  override readonly name = "CaptureError";
}

interface CallFrame {
  functionName: string;
  location: PausedLocation;
  receiver: RemoteObject | undefined;
  scopes: Array<{ type: string; objectId: string | undefined }>;
}

/** The clock of a capture in the app: `performance.now()` for its time limit, `Date.now()` for its time. */
export const SYSTEM_CLOCK: CaptureClock = { now: () => performance.now(), epochMs: () => Date.now() };

const readScopes = (raw: unknown): CallFrame["scopes"] =>
  Array.isArray(raw)
    ? raw.flatMap((scope: unknown) => {
        const type: unknown = isRecord(scope) ? Reflect.get(scope, "type") : undefined;
        const object = isRecord(scope) ? readRemoteObject(Reflect.get(scope, "object")) : undefined;
        return typeof type === "string" ? [{ type, objectId: object?.objectId }] : [];
      })
    : [];

const readCallFrame = (raw: unknown): CallFrame | undefined => {
  const location: unknown = isRecord(raw) ? Reflect.get(raw, "location") : undefined;
  if (!isRecord(raw) || !isRecord(location)) {
    return undefined;
  }

  const scriptId: unknown = Reflect.get(location, "scriptId");
  const lineNumber: unknown = Reflect.get(location, "lineNumber");
  const columnNumber: unknown = Reflect.get(location, "columnNumber");
  const functionName: unknown = Reflect.get(raw, "functionName");
  if (typeof scriptId !== "string" || typeof lineNumber !== "number" || typeof columnNumber !== "number") {
    return undefined;
  }

  return {
    functionName: typeof functionName === "string" ? functionName : "",
    location: { scriptId, lineNumber, columnNumber },
    receiver: readRemoteObject(Reflect.get(raw, "this")),
    scopes: readScopes(Reflect.get(raw, "scopeChain")),
  };
};

// Malformed outer frames are dropped before the first 20 are kept; without the innermost there is nothing to read,
// since the variables are those of the frame that hit the breakpoint
const readCallFrames = (params: unknown): CallFrame[] => {
  const raw: unknown = isRecord(params) ? Reflect.get(params, "callFrames") : undefined;
  const frames: CallFrame[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const frame = readCallFrame(item);
    if (frame === undefined && frames.length === 0) {
      return [];
    }

    if (frame !== undefined && frames.push(frame) === MAX_FRAMES) {
      break;
    }
  }

  return frames;
};

// A variable in the snapshot: its value so far, and the object to read on while that value is not final
interface Slot {
  name: string;
  value: Value;
  pending: RemoteObject | undefined;
}

interface SlotList {
  scopes: Slot[][];
  seen: Set<string>;
}

const unavailableSlot = (name: string, reason: string): Slot => ({
  name,
  value: { type: "unavailable", reason },
  pending: undefined,
});

const peekSlot = (property: Property, reader: ValueReader): Slot => {
  const { value, isFinal } = reader.peekVariable(property);
  return { name: property.name, value, pending: isFinal ? undefined : property.value };
};

// Adds the variables of one scope, each without an inspector call, so whatever the time; false once the snapshot is
// full, after one unavailable variable that says why, so a scope with thousands of names still fits its size
const peekScope = (scope: CallFrame["scopes"][number], reader: ValueReader, list: SlotList): boolean => {
  const listed: Listed =
    scope.objectId === undefined
      ? { ok: false, reason: "the inspector could not read the scope" }
      : reader.list(scope.objectId);
  if (!listed.ok) {
    // The names of a scope are unknown when it cannot be listed, so one variable stands for them
    list.scopes.push([unavailableSlot(`<${scope.type} scope>`, listed.reason)]);
    return reader.canRead();
  }

  const slots: Slot[] = [];
  list.scopes.push(slots);
  for (const property of listed.list.properties.filter(({ name }) => !list.seen.has(name))) {
    list.seen.add(property.name);
    const reason = reader.sizeStopReason();
    if (reason !== undefined) {
      slots.push(unavailableSlot(property.name, reason));
      return false;
    }

    slots.push(peekSlot(property, reader));
  }

  return true;
};

// The scopes from the innermost out, each variable read without an inspector call; a name that an inner scope has
// is not repeated by an outer one
const peekScopes = (frame: CallFrame, reader: ValueReader): Slot[][] => {
  const list: SlotList = { scopes: [], seen: new Set(["this"]) };
  for (const scope of frame.scopes.filter(({ type }) => SCOPE_TYPES.has(type))) {
    if (!peekScope(scope, reader, list)) {
      break;
    }
  }

  return list.scopes;
};

// Reads on the slots that are not final, in `order`, while the budget lasts; past it, a slot keeps its shell
const readOnSlots = (order: readonly Slot[], reader: ValueReader): Map<Slot, Value> => {
  const values = new Map<Slot, Value>();
  for (const slot of order) {
    if (slot.pending !== undefined) {
      values.set(slot, reader.readOn(slot.pending, slot.value));
    }
  }

  return values;
};

/**
 * `this`, then the scopes from the innermost out. Two passes, so a large value cannot leave the variables after it
 * out: every variable first gets what costs no inspector call, then the values are read on within the budget. The
 * innermost scope is read on from its last variable to its first, since V8 lists a function's own variables after its
 * parameters, such as a handler's `request` and `response`; then `this` and the outer scopes, each from its last.
 */
const readVariables = (frame: CallFrame, reader: ValueReader): Variable[] => {
  const receiver =
    frame.receiver === undefined
      ? []
      : [peekSlot({ name: "this", value: frame.receiver, isAccessor: false, isEnumerable: true }, reader)];
  const scopes = peekScopes(frame, reader);
  const [innermost = [], ...outer] = scopes;
  const order = [...innermost.toReversed(), ...receiver, ...outer.flatMap((slots) => slots.toReversed())];
  const values = readOnSlots(order, reader);
  return [...receiver, ...scopes.flat()].map((slot) => ({ name: slot.name, value: values.get(slot) ?? slot.value }));
};

const toStackFrame = (frame: CallFrame, location: FrameLocation): StackFrame => ({
  function: frame.functionName,
  ...location,
});

/**
 * Reads the stack and the variables of the innermost frame of a `Debugger.paused` event, with `Runtime.getProperties`
 * only, within the largest of `limits` (a breakpoint without limits counts as the defaults). At 10 ms or 64 KiB the
 * read is truncated: the first value not read is `unavailable` and the rest of its object or array is left out, while
 * every variable that fits the size keeps what costs no call, its primitive value or its shell. Throws `CaptureError`
 * when the innermost frame cannot be read.
 */
export const readPause = (
  params: unknown,
  limits: ReadonlyArray<CaptureLimits | undefined>,
  dependencies: CaptureDependencies,
): PauseRead => {
  const frames = readCallFrames(params);
  const [innermost] = frames;
  if (innermost === undefined) {
    throw new CaptureError("the pause has no innermost call frame to read");
  }

  const clock = dependencies.clock ?? SYSTEM_CLOCK;
  const budget = new CaptureBudget(clock.now, dependencies.budget ?? DEFAULT_BUDGET);
  const stack = frames.map((frame) => toStackFrame(frame, dependencies.locateFrame(frame.location)));
  for (const frame of stack) {
    budget.charge(frame.function.length + frame.file.length + 64);
  }

  const reader = new ValueReader(dependencies.session, {
    limits: largestLimits(limits),
    budget,
    isSecret: dependencies.isSecret,
  });
  const variables = readVariables(innermost, reader);
  return { time: clock.epochMs(), stack, variables, truncated: budget.wasCut };
};
