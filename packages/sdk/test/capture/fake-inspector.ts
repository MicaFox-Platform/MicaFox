// A fake V8 for the capture's unit tests: it answers `Runtime.getProperties` from a table of objects and records
// every call, so a test sees which objects the capture asked about.

import type { CaptureInspector } from "../../src/debugger/capture/index.js";

/** A RemoteObject as V8 writes it. */
export type Remote = Record<string, unknown>;

/** A property descriptor as `Runtime.getProperties` writes it. */
export type Described = Record<string, unknown>;

export const number = (value: number): Remote => ({ type: "number", value, description: String(value) });
export const text = (value: string): Remote => ({ type: "string", value });

/** A reference to an object that the fake can list under `objectId`. */
export const reference = (
  objectId: string,
  describe: { subtype?: string; className?: string; description?: string } = {},
): Remote => ({ type: "object", className: "Object", description: "Object", ...describe, objectId });

/** A data property; V8 lists the enumerable ones of an object literal. */
export const data = (name: string, value: Remote, enumerable = true): Described => ({
  name,
  value,
  enumerable,
  configurable: true,
  writable: true,
  isOwn: true,
});

/** A property with a getter, which has no `value`. */
export const getter = (name: string): Described => ({
  name,
  get: reference(`getter-${name}`),
  set: { type: "undefined" },
  enumerable: true,
  isOwn: true,
});

interface Listing {
  result: Described[];
  internalProperties?: Described[];
}

/** An inspector with the objects of a test; an object it does not know fails like V8 does for a released id. */
export class FakeInspector implements CaptureInspector {
  /** Every command in order, with the object it was about. */
  readonly posted: Array<{ method: string; objectId: unknown }> = [];
  private readonly listings = new Map<string, Listing>();
  private readonly failing = new Set<string>();
  /** Runs before each command is answered, such as to move a fake clock. */
  onPost: () => void = () => undefined;

  /** Makes `Runtime.getProperties` of `objectId` answer with these properties. */
  define(objectId: string, result: Described[], internalProperties?: Described[]): void {
    this.listings.set(objectId, internalProperties === undefined ? { result } : { result, internalProperties });
  }

  /** Makes `Runtime.getProperties` of `objectId` fail. */
  fail(objectId: string): void {
    this.failing.add(objectId);
  }

  /** The number of commands about `objectId`. */
  callsAbout(objectId: string): number {
    return this.posted.filter((call) => call.objectId === objectId).length;
  }

  post(method: string, params?: object): { ok: true; value: object } | { ok: false; error: Error } {
    const objectId: unknown = params === undefined ? undefined : Reflect.get(params, "objectId");
    this.posted.push({ method, objectId });
    this.onPost();
    const listing = typeof objectId === "string" ? this.listings.get(objectId) : undefined;
    if (listing === undefined || (typeof objectId === "string" && this.failing.has(objectId))) {
      return { ok: false, error: new Error("Could not find object with given id") };
    }

    return { ok: true, value: listing };
  }
}

/** One call frame of a fake `Debugger.paused` event. */
export interface FakeFrame {
  functionName?: string;
  scriptId?: string;
  lineNumber?: number;
  columnNumber?: number;
  receiver?: Remote;
  scopes?: Array<{ type: string; objectId?: string }>;
}

/** The params of a `Debugger.paused` event with these frames, innermost first. */
export const pausedAt = (...frames: FakeFrame[]): object => ({
  reason: "other",
  callFrames: frames.map((frame, index) => ({
    callFrameId: String(index),
    functionName: frame.functionName ?? "",
    location: {
      scriptId: frame.scriptId ?? "1",
      lineNumber: frame.lineNumber ?? 0,
      columnNumber: frame.columnNumber ?? 0,
    },
    url: "",
    this: frame.receiver ?? { type: "undefined" },
    scopeChain: (frame.scopes ?? []).map((scope) => ({
      type: scope.type,
      object: scope.objectId === undefined ? { type: "object" } : reference(scope.objectId),
    })),
  })),
});
