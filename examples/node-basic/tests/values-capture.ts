// Captures the values of one route of src/values.ts: a breakpoint on its marked line, a request and the snapshot the
// fake hub prints. The tests check encodings and the size limit, not the SDK's 10 ms per pause: a loaded machine,
// such as a full `pnpm verify`, can reach that on a pause and cut the values a test checks, so a capture cut by
// anything but size is taken again; one cut by size is kept.

import type { CaptureLimits, Snapshot, Value } from "@micafox/protocol";
import path from "node:path";

import type { ChildProcessRun } from "./child-process-run.js";
import { readType } from "./child-process-run.js";
import { findMarkerLine, readStatus, startApp, startHub, toAppUrl, waitForStatus } from "./harness.js";

const VALUES_FILE = path.join(import.meta.dirname, "..", "src", "values.ts");
// The breakpoint names its file as a hub does, by the path in the repository
const VALUES_REPOSITORY_PATH = "examples/node-basic/src/values.ts";
const VALUES_MARKER = "// breakpoint on the next line:";
// The reason of the first value a capture cut by its size limit did not read (docs/api/protocol.md#snapshot). A cut
// by time is told by its absence: one inside an array, Set or Map leaves no reason, only the missing children
const SIZE_LIMIT_REASON = "the snapshot reached its size limit";
// A capture after a slow pause can wait for the process's pause budget to refill at 20 ms per second, about 2 s
// after a 40 ms pause, so three captures and two process starts fit in E2E_TEST_TIMEOUT_MS
const MAX_CAPTURES = 3;

/** The route groups of `src/values.ts`. */
export type ValuesGroup = "primitives" | "nesting" | "collections" | "objects" | "large" | "secrets";

/** What a test changes about a values capture; each field is unset by default. */
export interface CaptureValuesOptions {
  /** `limits` of the breakpoint. */
  limits?: CaptureLimits;
  /** `VALUES_SECRET`. */
  secret?: string;
}

/** The capture of one `/values/<group>` request, with both processes it ran in. */
export interface ValuesCapture {
  readonly snapshot: Snapshot;
  /** The HTTP status the route answered with. */
  readonly httpStatus: number;
  readonly hub: ChildProcessRun;
  readonly app: ChildProcessRun;
}

interface Attempt {
  /** Undefined when the breakpoint was off, rate limited by an earlier slow pause. */
  readonly snapshot: Snapshot | undefined;
  readonly httpStatus: number;
}

const isCutByTime = (snapshot: Snapshot): boolean =>
  snapshot.truncated === true && !JSON.stringify(snapshot).includes(SIZE_LIMIT_REASON);

const hasStatus =
  (breakpointId: string, status: string) =>
  (line: string): boolean => {
    const message = readStatus(line);
    return message?.breakpointId === breakpointId && message.status === status;
  };

// Resolves with the first line that matches from now on: waitForLines() also counts the lines already printed
const waitForNext = async (hub: ChildProcessRun, predicate: (line: string) => boolean): Promise<string> => {
  const lines = await hub.waitForLines(predicate, hub.lines.filter(predicate).length + 1);
  return lines.at(-1) ?? "";
};

// A slow pause can spend the process's 20 ms of pause time per second: the SDK then sends `rateLimited` right after
// the snapshot, and a request answers without a pause until it sends `active` again. Either order is handled: a
// `rateLimited` already printed is waited out first, and one that comes instead of the snapshot ends the attempt.
// An attempt that gets neither, such as a lost frame, waits until the test's timeout: a failure the test shows
const requestSnapshot = async (hub: ChildProcessRun, url: string, breakpointId: string): Promise<Attempt> => {
  const isRateLimited = hasStatus(breakpointId, "rateLimited");
  const lastStatus = hub.lines.filter((line) => readStatus(line)?.breakpointId === breakpointId).at(-1);
  if (lastStatus !== undefined && isRateLimited(lastStatus)) {
    await waitForNext(hub, hasStatus(breakpointId, "active"));
  }

  const outcome = waitForNext(hub, (line) => readType(line) === "snapshot" || isRateLimited(line));
  // A failed fetch rejects first; the outcome then rejects when the test kills the hub, which is not a new failure
  outcome.catch(() => undefined);
  const response = await fetch(url);
  await response.arrayBuffer();
  const line = await outcome;
  // A `snapshot` line of the fake hub holds a snapshot message
  const snapshot = readType(line) === "snapshot" ? (JSON.parse(line) as Snapshot) : undefined;
  return { snapshot, httpStatus: response.status };
};

/**
 * Sets a breakpoint on the marked line of `group` in `src/values.ts`, requests its route and resolves with the first
 * snapshot not cut by the time limit. The line is the one after the marker `// breakpoint on the next line: <group>`.
 */
export const captureValues = async (group: ValuesGroup, options: CaptureValuesOptions = {}): Promise<ValuesCapture> => {
  const line = findMarkerLine(VALUES_FILE, `${VALUES_MARKER} ${group}`) + 1;
  const breakpoint = { id: `bp-${group}`, file: VALUES_REPOSITORY_PATH, line, limits: options.limits };
  const hub = await startHub({ breakpoints: [breakpoint] });
  const secret = options.secret === undefined ? {} : { valuesSecret: options.secret };
  const app = await startApp({ hubPort: hub.port, ...secret });
  await waitForStatus(hub.run, breakpoint.id, (status) => status.status === "active");

  const url = toAppUrl(app.port, `/values/${group}`);
  for (let attempt = 1; attempt <= MAX_CAPTURES; attempt += 1) {
    const { snapshot, httpStatus } = await requestSnapshot(hub.run, url, breakpoint.id);
    if (snapshot !== undefined && !isCutByTime(snapshot)) {
      return { snapshot, httpStatus, hub: hub.run, app: app.run };
    }
  }

  throw new Error(`no snapshot of /values/${group} within the time limit in ${String(MAX_CAPTURES)} captures`);
};

/** The value of the variable `name` in `snapshot`; `undefined` when the snapshot has none. */
export const readVariable = (snapshot: Snapshot, name: string): Value | undefined =>
  snapshot.variables.find((variable) => variable.name === name)?.value;
