import { performance } from "node:perf_hooks";

import { resolveMapSources, type MapSource } from "./map-sources.js";
import { readSourceMap, type MappedScript } from "./read-source-map.js";
import type { SdkLogger } from "../../logger/index.js";
import { decodeSourceMap, type SourceMapIndex } from "../source-map-decoder/index.js";

const COMPONENT = "debugger";

/** What is known of a script's map: its sources resolved to paths and, while the script holds it, its index. */
export type MapView =
  | { kind: "unread" }
  | { kind: "reading" }
  | { kind: "failed"; reason: string }
  | { kind: "read"; sources: readonly MapSource[]; index?: SourceMapIndex };

type MapState<Script> =
  | { kind: "reading"; script: Script }
  | { kind: "failed"; script: Script; reason: string }
  | { kind: "read"; script: Script; sources: readonly MapSource[]; index?: SourceMapIndex };

interface ReadingState<Script> {
  kind: "reading";
  script: Script;
}

type Decoded = { ok: true; bytes: number; sources: MapSource[]; index: SourceMapIndex } | { ok: false; reason: string };

/** What `SourceMaps` needs from the breakpoints; `Script` is their record of a script. */
export interface SourceMapsDependencies<Script extends MappedScript> {
  logger: SdkLogger;
  /** Runs when the read of a script's current record ends, so the entries waiting for it are resolved again. */
  onRead: (script: Script) => void;
  /** Reports an unexpected error of a read: the debugger stops itself. */
  fail: (error: unknown) => void;
}

const UNREAD: MapView = { kind: "unread" };

const describeMap = (script: MappedScript): string =>
  script.sourceMapUrl.startsWith("data:") ? `inline in ${script.url}` : `${script.sourceMapUrl} of ${script.url}`;

const readAndDecode = async (script: MappedScript): Promise<Decoded> => {
  const read = await readSourceMap(script);
  if (!read.ok) {
    return read;
  }

  const decoded = await decodeSourceMap(read.text);
  if (!decoded.ok) {
    return decoded;
  }

  const { map } = decoded;
  return {
    ok: true,
    bytes: read.bytes,
    sources: resolveMapSources(map.sourceRoot, map.sources, read.mapUrl),
    index: map,
  };
};

/**
 * The source maps of the loaded scripts, read once per script record and shared by every entry that needs them.
 * Maps are read one at a time, in the order they were asked for, so at most one 8 MiB text and one partial index
 * are in memory and the host's thread pool keeps its other threads. The decoded index of a map, up to about 36 MB,
 * is kept only while an entry holds its script; for the others only the resolved sources are kept, so a pending
 * entry does not read them again. The states and the queue hold at most one item per recorded script and are
 * dropped with the records.
 */
export class SourceMaps<Script extends MappedScript> {
  private readonly states = new Map<string, MapState<Script>>();
  /** The entries whose breakpoint is set through the map of each script URL. */
  private readonly holders = new Map<string, Set<string>>();
  private queue: Array<ReadingState<Script>> = [];
  private queueHead = 0;
  private isReading = false;

  constructor(private readonly dependencies: SourceMapsDependencies<Script>) {}

  /** What is known of the map of `script`; a script with the URL of an earlier record starts as unread. */
  view(script: Script): MapView {
    const state = this.states.get(script.url);
    if (state?.script !== script) {
      return UNREAD;
    }

    switch (state.kind) {
      case "reading":
        return { kind: "reading" };
      case "failed":
        return { kind: "failed", reason: state.reason };
      case "read":
        return state.index === undefined
          ? { kind: "read", sources: state.sources }
          : { kind: "read", sources: state.sources, index: state.index };
    }
  }

  /** Queues the map of `script` for reading, unless it is queued or what is known already serves every lookup. */
  load(script: Script): void {
    const state = this.states.get(script.url);
    const isKnown = state?.script === script && (state.kind !== "read" || state.index !== undefined);
    if (isKnown) {
      return;
    }

    const reading: ReadingState<Script> = { kind: "reading", script };
    this.states.set(script.url, reading);
    this.queue.push(reading);
    this.readNext();
  }

  /** Forgets the map of a URL whose script was recorded again; a read of the old record is ignored when it ends. */
  forget(url: string): void {
    this.states.delete(url);
  }

  /** Keeps the index of `script`'s map while `owner` has a breakpoint set through it. */
  hold(script: Script, owner: string): void {
    const owners = this.holders.get(script.url) ?? new Set<string>();
    owners.add(owner);
    this.holders.set(script.url, owners);
  }

  /** Ends `owner`'s hold on the map of `url`; the index goes with the last owner. */
  release(url: string, owner: string): void {
    const owners = this.holders.get(url);
    owners?.delete(owner);
    if (owners?.size === 0) {
      this.holders.delete(url);
      this.dropIndex(url);
    }
  }

  /** Drops the index of `script`'s map when no entry holds it, after the entries waiting for it were resolved. */
  trim(script: Script): void {
    if (!this.holders.has(script.url)) {
      this.dropIndex(script.url);
    }
  }

  /** Forgets every map and the queue; a read still running is ignored when it ends. */
  clear(): void {
    this.states.clear();
    this.holders.clear();
    this.queue = [];
    this.queueHead = 0;
  }

  private dropIndex(url: string): void {
    const state = this.states.get(url);
    if (state?.kind === "read" && state.index !== undefined) {
      this.states.set(url, { kind: "read", script: state.script, sources: state.sources });
    }
  }

  // A queued read whose record was forgotten or read again is skipped without I/O
  private readNext(): void {
    if (this.isReading) {
      return;
    }

    while (this.queueHead < this.queue.length) {
      const reading = this.queue[this.queueHead];
      this.queueHead += 1;
      if (reading !== undefined && this.states.get(reading.script.url) === reading) {
        this.isReading = true;
        void this.read(reading);
        return;
      }
    }

    this.queue = [];
    this.queueHead = 0;
  }

  // Never rejects: what ends a read is logged, and an unexpected error stops the debugger
  private async read(reading: ReadingState<Script>): Promise<void> {
    try {
      const startedMs = performance.now();
      const decoded = await readAndDecode(reading.script);
      this.settle(reading, decoded, performance.now() - startedMs);
    } catch (error) {
      this.dependencies.fail(error);
    } finally {
      this.isReading = false;
      this.readNext();
    }
  }

  private settle(reading: ReadingState<Script>, decoded: Decoded, elapsedMs: number): void {
    const { script } = reading;
    if (this.states.get(script.url) !== reading) {
      this.log("debug", `source map ${describeMap(script)} ignored: its script record is gone`);
      return;
    }

    if (decoded.ok) {
      this.states.set(script.url, { kind: "read", script, sources: decoded.sources, index: decoded.index });
      this.log(
        "debug",
        `source map loaded: ${describeMap(script)}, ${String(decoded.bytes)} bytes, ${String(Math.round(elapsedMs))} ms`,
      );
    } else {
      this.states.set(script.url, { kind: "failed", script, reason: decoded.reason });
      this.log("warn", `source map ${describeMap(script)} cannot be used: ${decoded.reason}`);
    }

    this.dependencies.onRead(script);
  }

  private log(level: "debug" | "warn", message: string): void {
    this.dependencies.logger.log(level, message, { component: COMPONENT });
  }
}
