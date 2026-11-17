// What the framework examples share: each app serves `GET /quote`, and a breakpoint on the line of its handler marked
// `// breakpoint here` captures the request's values. An example describes its app as a QuoteApp; starting the fake hub
// and the app, and waiting on what they print, come from here.

import type { BreakpointStatus, Snapshot } from "@micafox/protocol";
import path from "node:path";

import { readType, type ChildProcessRun, type Exit } from "./child-process-run.js";
import { startHub, waitForStatus } from "./hub.js";
import { findMarkerLine } from "./markers.js";
import { createEnvironment, startProcess, type ListeningRun, type Readiness } from "./processes.js";
import { fetchInARow } from "./requests.js";

const QUOTE_MARKER = "// breakpoint here";

// tools/testkit/src/ → the repository root, where a hub's breakpoint paths begin
const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..", "..");

// The id of the one breakpoint each test sets
const QUOTE_BREAKPOINT_ID = "bp-quote";

/** One framework app: how node starts it and the source file of its `GET /quote` handler. */
export interface QuoteApp {
  readonly name: string;
  /** The absolute directory of the example, where `node` starts and the paths below begin. */
  readonly directory: string;
  /** The arguments of `node`, with paths relative to `directory`. */
  readonly args: readonly string[];
  /** The source file of the handler, relative to `directory`. */
  readonly quoteSource: string;
  /** The line the app prints once it serves HTTP, and the line that holds its port as the first group. */
  readonly ready: Readiness;
  /** How the app ends on SIGTERM. */
  readonly exitOnSigterm: Exit;
  /** The line the app prints on SIGTERM once it has stopped the SDK, or started to. */
  readonly stopMarker: string;
  /** Environment variables the app needs, by name. */
  readonly env?: ReadonlyMap<string, string>;
}

/** The path of the handler's source in the repository, with `/` separators, as a hub sets a breakpoint on it. */
export const toQuoteRepositoryPath = (app: QuoteApp): string =>
  path.relative(REPOSITORY_ROOT, path.join(app.directory, app.quoteSource)).split(path.sep).join("/");

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Matches the absolute path or URL of the handler's source that a snapshot's stack frame reports. */
export const toQuoteFilePattern = (app: QuoteApp): RegExp =>
  new RegExp(`/${escapeRegExp(toQuoteRepositoryPath(app))}$`);

/** The 1-based line of the marked line of `app`'s quote handler, found by its marker so edits do not break tests. */
export const findQuoteLine = (app: QuoteApp): number =>
  findMarkerLine(path.join(app.directory, app.quoteSource), QUOTE_MARKER);

/** Starts the fake hub with one breakpoint on the marked line of `app`'s quote handler; resolves once it listens. */
export const startQuoteHub = (app: QuoteApp): Promise<ListeningRun> => {
  const breakpoint = {
    id: QUOTE_BREAKPOINT_ID,
    file: toQuoteRepositoryPath(app),
    line: findQuoteLine(app),
  };
  return startHub({ breakpoints: [breakpoint] });
};

/** Starts `app` connected to the fake hub on `hubPort`; resolves once it serves HTTP. */
export const startQuoteApp = (app: QuoteApp, hubPort: number): Promise<ListeningRun> => {
  // The developer's own NEXT_* variables never reach the apps; Next.js reads them
  const env = { ...createEnvironment({ prefixes: ["NEXT_"] }), ...Object.fromEntries(app.env ?? []) };
  env.MICAFOX_HUB_URL = `ws://127.0.0.1:${String(hubPort)}/micafox`;
  return startProcess({ name: `${app.name} app`, args: app.args, env, cwd: app.directory, readiness: app.ready });
};

/** The URL of `pathname` on the app on `port`; `GET /quote` by default. */
export const toQuoteUrl = (port: number, pathname = "/quote?sku=SKU-2&quantity=3"): string =>
  `http://127.0.0.1:${String(port)}${pathname}`;

/**
 * Sends GET requests to `url`, one at a time, until the fake hub has printed a snapshot, and resolves with it. Slow
 * pauses, such as the first of a freshly started process on a CI runner, use up the 20 ms a second the app may be
 * paused, so the next requests in that second capture nothing. A snapshot the 10 ms cut short still holds the
 * handler's own variables: the SDK reads them before its `request` and `response`.
 */
export const fetchUntilSnapshot = async (url: string, hub: ChildProcessRun): Promise<Snapshot> => {
  const isSnapshot = (line: string): boolean => readType(line) === "snapshot";
  const state = { isSettled: false };
  const found = hub.waitForLines(isSnapshot).finally(() => {
    state.isSettled = true;
  });
  while (!state.isSettled) {
    await fetchInARow(url, 1);
  }
  const [line = ""] = await found;
  // isSnapshot() has accepted the line as a snapshot
  return JSON.parse(line) as Snapshot;
};

/** Resolves with the first `breakpointStatus` of the quote breakpoint the fake hub printed that `isWanted` accepts. */
export const waitForQuoteStatus = (
  hub: ChildProcessRun,
  isWanted?: (status: BreakpointStatus) => boolean,
): Promise<BreakpointStatus> => waitForStatus(hub, QUOTE_BREAKPOINT_ID, isWanted);

/**
 * Sends SIGTERM to `app` and resolves once the fake hub has printed `disconnected`, after the connection's last
 * message, so the hub's output is complete. Resolves with how `app` exited and whether it printed its stop marker.
 */
export const shutDownQuoteApp = async (
  app: QuoteApp,
  server: ChildProcessRun,
  hub: ChildProcessRun,
): Promise<{ exit: Exit; stopped: boolean }> => {
  server.stop("SIGTERM");
  await hub.waitForLines((line) => line === "disconnected");
  const exit = await server.exited;
  return { exit, stopped: server.lines.includes(app.stopMarker) };
};
