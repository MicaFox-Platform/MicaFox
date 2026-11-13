// Starts one framework app of this example and the kit's fake hub as real child processes. The apps run their built
// output under plain `node`, so they load the SDK's built `dist/`. Each app serves HTTP from the one process it starts,
// so killing it leaves no worker behind. Processes, waits and the fake hub come from @micafox/testkit.

import type { BreakpointStatus, CaptureLimits, Snapshot } from "@micafox/protocol";
import {
  createEnvironment,
  fetchInARow,
  findMarkerLine,
  LISTENING,
  readType,
  startHub as startFakeHub,
  startProcess,
  waitForStatus as waitForBreakpointStatus,
  type ChildProcessRun,
  type Exit,
  type ListeningRun,
  type Readiness,
} from "@micafox/testkit";
import path from "node:path";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");
const QUOTE_MARKER = "// breakpoint here";

// The id of the one breakpoint each test sets
const BREAKPOINT_ID = "bp-quote";

/** One framework app of src/: how node starts it and the source file of its `GET /quote` handler. */
export interface App {
  readonly name: string;
  /** The arguments of `node`, with paths relative to the example. */
  readonly args: readonly string[];
  readonly quoteSource: string;
  /** The line the app prints once it serves HTTP, and the line that holds its port as the first group. */
  readonly ready: Readiness;
  /** How the app ends on SIGTERM. */
  readonly exitOnSigterm: Exit;
  /** The line the app prints on SIGTERM once it has stopped the SDK, or started to. */
  readonly stopMarker: string;
  /** Environment variables the app needs, by name. */
  readonly env?: ReadonlyMap<string, string>;
  /** The capture limits of the breakpoint the hub sets on the handler, when the defaults do not fit. */
  readonly limits?: CaptureLimits;
}

/** Express 5 in plain CommonJS JavaScript. */
export const EXPRESS_APP: App = {
  name: "Express",
  args: ["src/express/server.js"],
  quoteSource: "src/express/quote.js",
  ready: LISTENING,
  exitOnSigterm: 0,
  stopMarker: "micafox stopped",
  // The handler's `request` and `response` come first in its scope and are large: at the default depth of 3, reading
  // them can take the 10 ms of a pause on a slow machine, and the locals after them are left out of the snapshot
  limits: { maxDepth: 1 },
};

/** NestJS compiled by the Nest CLI; Nest ends the process by the signal it received, after its shutdown hooks. */
export const NESTJS_APP: App = {
  name: "NestJS",
  args: ["dist/nestjs/main.js"],
  quoteSource: "src/nestjs/quote.controller.ts",
  ready: LISTENING,
  exitOnSigterm: "SIGTERM",
  stopMarker: "micafox stopped",
};

/** Next.js built by `next build` and served by `next start` on the Node.js runtime. */
export const NEXTJS_APP: App = {
  name: "Next.js",
  // `next start` serves from its own process, so no worker process can be orphaned. Port 0 picks a free port, which
  // Next.js prints on its `- Local:` line, before `Ready`
  args: ["node_modules/next/dist/bin/next", "start", "src/nextjs", "--hostname", "127.0.0.1", "--port", "0"],
  quoteSource: "src/nextjs/app/quote/route.ts",
  ready: { ready: /^✓ Ready in /, port: /^- Local:\s+http:\/\/127\.0\.0\.1:(\d+)$/ },
  // `next start` shuts down gracefully on SIGTERM and exits with 128 + 15
  exitOnSigterm: 143,
  // Next.js exits by itself, so instrumentation-node.ts only starts stop() and does not wait for it
  stopMarker: "micafox stopping",
  env: new Map([
    // Vitest sets NODE_ENV=test, which `next start` keeps
    ["NODE_ENV", "production"],
    ["NEXT_TELEMETRY_DISABLED", "1"],
  ]),
};

/** The path of `file` in the repository, as a hub sets a breakpoint on it. */
export const toRepositoryPath = (file: string): string => `examples/frameworks/${file}`;

/** The 1-based line of the marked line of `app`'s quote handler, found by its marker so edits do not break tests. */
export const findQuoteLine = (app: App): number =>
  findMarkerLine(path.join(EXAMPLE_DIR, app.quoteSource), QUOTE_MARKER);

/** Starts the fake hub with one breakpoint on the marked line of `app`'s quote handler; resolves once it listens. */
export const startHub = (app: App): Promise<ListeningRun> => {
  const breakpoint = {
    id: BREAKPOINT_ID,
    file: toRepositoryPath(app.quoteSource),
    line: findQuoteLine(app),
    ...(app.limits === undefined ? {} : { limits: app.limits }),
  };
  return startFakeHub({ breakpoints: [breakpoint] });
};

/** Starts `app` connected to the fake hub on `hubPort`; resolves once it serves HTTP. */
export const startApp = (app: App, hubPort: number): Promise<ListeningRun> => {
  // The developer's own NEXT_* variables never reach the apps; Next.js reads them
  const env = { ...createEnvironment({ prefixes: ["NEXT_"] }), ...Object.fromEntries(app.env ?? []) };
  env.MICAFOX_HUB_URL = `ws://127.0.0.1:${String(hubPort)}/micafox`;
  return startProcess({ name: `${app.name} app`, args: app.args, env, cwd: EXAMPLE_DIR, readiness: app.ready });
};

/** The URL of `pathname` on the app on `port`; `GET /quote` by default. */
export const toUrl = (port: number, pathname = "/quote?sku=SKU-2&quantity=3"): string =>
  `http://127.0.0.1:${String(port)}${pathname}`;

/**
 * Sends GET requests to `url`, one at a time, until the fake hub has printed a snapshot that is not `truncated`, and
 * resolves with it. The first pause of a freshly started process can take the whole 10 ms of a pause on a slow machine,
 * such as a CI runner, before it reads a variable, and slow pauses use up the 20 ms a second the app may be paused, so
 * the snapshots of the next requests in that second are not taken. Requests go on until a warm pause reads them all.
 */
export const fetchUntilCompleteSnapshot = async (url: string, hub: ChildProcessRun): Promise<Snapshot> => {
  const isComplete = (line: string): boolean =>
    readType(line) === "snapshot" && (JSON.parse(line) as Snapshot).truncated !== true;
  const state = { isSettled: false };
  const found = hub.waitForLines(isComplete).finally(() => {
    state.isSettled = true;
  });
  while (!state.isSettled) {
    await fetchInARow(url, 1);
  }
  const [line = ""] = await found;
  // isComplete() has accepted the line as a snapshot
  return JSON.parse(line) as Snapshot;
};

/** Resolves with the first `breakpointStatus` of BREAKPOINT_ID the fake hub printed that `isWanted` accepts. */
export const waitForStatus = (
  hub: ChildProcessRun,
  isWanted?: (status: BreakpointStatus) => boolean,
): Promise<BreakpointStatus> => waitForBreakpointStatus(hub, BREAKPOINT_ID, isWanted);

/**
 * Sends SIGTERM to `app` and resolves once the fake hub has printed `disconnected`, after the connection's last
 * message, so the hub's output is complete. Resolves with how `app` exited and whether it printed its stop marker.
 */
export const shutDown = async (
  app: App,
  server: ChildProcessRun,
  hub: ChildProcessRun,
): Promise<{ exit: Exit; stopped: boolean }> => {
  server.stop("SIGTERM");
  await hub.waitForLines((line) => line === "disconnected");
  const exit = await server.exited;
  return { exit, stopped: server.lines.includes(app.stopMarker) };
};
