// Starts one framework app of this example and the fake hub as real child processes and waits on what they print. The
// apps run their built output under plain `node`, so they load the SDK's built `dist/`; the fake hub runs through tsx.
// useProcesses() kills and awaits every process a test started, so none outlives it. Each app serves HTTP from the one
// process it starts, so killing it leaves no worker behind. Adapted from examples/module-formats/tests/harness.ts.

import type { BreakpointStatus, CaptureLimits, Snapshot } from "@micafox/protocol";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";

import { ChildProcessRun, readType, type Exit } from "./child-process-run.js";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");
const HUB_FILE = path.join(EXAMPLE_DIR, "tests", "fake-hub.ts");
// The fake hub, the Express app and the NestJS app print this line once they serve
const LISTENING = /^listening on port (\d+)$/;
const QUOTE_MARKER = "// breakpoint here";

/** The timeout of each test: two process starts and a few requests fit well within it. */
export const E2E_TEST_TIMEOUT_MS = 10_000;

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

/** The line a process prints once it serves, and the line that holds its port as the first group. */
interface Readiness {
  readonly ready: RegExp;
  readonly port: RegExp;
}

const LISTENING_READINESS: Readiness = { ready: LISTENING, port: LISTENING };

/** Express 5 in plain CommonJS JavaScript. */
export const EXPRESS_APP: App = {
  name: "Express",
  args: ["src/express/server.js"],
  quoteSource: "src/express/quote.js",
  ready: LISTENING_READINESS,
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
  ready: LISTENING_READINESS,
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

/**
 * The 1-based line of the marked line of `app`'s quote handler, found by its marker so edits do not break tests. A
 * lost marker fails here, not as a breakpoint on line 0 that a test would wait on until its timeout.
 */
export const findQuoteLine = (app: App): number => {
  const index = readFileSync(path.join(EXAMPLE_DIR, app.quoteSource), "utf8")
    .split("\n")
    .findIndex((line) => line.includes(QUOTE_MARKER));
  if (index === -1) {
    throw new Error(`no line of ${app.quoteSource} holds the marker "${QUOTE_MARKER}"`);
  }

  return index + 1;
};

// The developer's own MICAFOX_*, HUB_*, NEXT_* and PORT variables never reach the processes: each test sets its own
const createEnvironment = (): Record<string, string> => {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(MICAFOX_|HUB_|NEXT_)/.test(entry[0]) && entry[0] !== "PORT",
  );
  const environment = Object.fromEntries(inherited);
  environment.PORT = "0";
  return environment;
};

/** A started process and the port it printed that it listens on. */
export interface ListeningRun {
  readonly run: ChildProcessRun;
  readonly port: number;
}

const started = new Set<ChildProcessRun>();

const start = async (run: ChildProcessRun, readiness: Readiness): Promise<ListeningRun> => {
  started.add(run);
  await run.waitForLines((candidate) => readiness.ready.test(candidate));
  // The port line comes with or before the ready line
  const portLine = run.lines.find((line) => readiness.port.test(line)) ?? "";
  return { run, port: Number(readiness.port.exec(portLine)?.[1]) };
};

/** Starts the fake hub with one breakpoint on the marked line of `app`'s quote handler; resolves once it listens. */
export const startHub = (app: App): Promise<ListeningRun> => {
  const breakpoint = {
    id: BREAKPOINT_ID,
    file: toRepositoryPath(app.quoteSource),
    line: findQuoteLine(app),
    ...(app.limits === undefined ? {} : { limits: app.limits }),
  };
  const env = createEnvironment();
  env.HUB_BREAKPOINTS = JSON.stringify([breakpoint]);
  // tsx as an import, so no wrapper process can be orphaned
  return start(new ChildProcessRun("fake hub", ["--import", "tsx", HUB_FILE], env), LISTENING_READINESS);
};

/** Starts `app` connected to the fake hub on `hubPort`; resolves once it serves HTTP. */
export const startApp = (app: App, hubPort: number): Promise<ListeningRun> => {
  const env = { ...createEnvironment(), ...Object.fromEntries(app.env ?? []) };
  env.MICAFOX_HUB_URL = `ws://127.0.0.1:${String(hubPort)}/micafox`;
  return start(new ChildProcessRun(`${app.name} app`, app.args, env), app.ready);
};

/** The URL of `pathname` on the app on `port`; `GET /quote` by default. */
export const toUrl = (port: number, pathname = "/quote?sku=SKU-2&quantity=3"): string =>
  `http://127.0.0.1:${String(port)}${pathname}`;

/** The `breakpointStatus` a line of the fake hub holds; fake-hub.ts prints every message it receives as one line. */
export const readStatus = (line: string): BreakpointStatus | undefined =>
  readType(line) === "breakpointStatus" ? (JSON.parse(line) as BreakpointStatus) : undefined;

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
export const waitForStatus = async (
  hub: ChildProcessRun,
  isWanted: (status: BreakpointStatus) => boolean = () => true,
): Promise<BreakpointStatus> => {
  const [line = ""] = await hub.waitForLines((candidate) => {
    const status = readStatus(candidate);
    return status?.breakpointId === BREAKPOINT_ID && isWanted(status);
  });
  // readStatus() has accepted the line as a breakpointStatus
  return JSON.parse(line) as BreakpointStatus;
};

/** Sends `count` GET requests to `url`, each after the previous one answered; resolves with their HTTP statuses. */
export const fetchInARow = async (url: string, count: number): Promise<number[]> => {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(url);
    await response.arrayBuffer();
    statuses.push(response.status);
  }
  return statuses;
};

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

/** Kills every process a test started after the test, and waits until each has exited. */
export const useProcesses = (): void => {
  // A worker that dies before afterEach still takes its processes along; kill() is synchronous, as `exit` needs
  process.once("exit", () => {
    for (const run of started) {
      run.stop("SIGKILL");
    }
  });
  afterEach(async (context) => {
    const runs = [...started];
    started.clear();
    // A timeout reports no output of its own: print what each process said, so a failure in CI can be read
    if (context.task.result?.state === "fail") {
      for (const run of runs) {
        console.error(`${run.name} printed:\n${run.lines.join("\n")}`);
      }
    }
    for (const run of runs) {
      run.stop("SIGKILL");
    }
    await Promise.all(runs.map((run) => run.exited));
  });
};
