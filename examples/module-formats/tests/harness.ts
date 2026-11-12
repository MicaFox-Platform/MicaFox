// Starts one app of this example and the fake hub as real child processes and waits on what they print. The apps run
// under plain `node`, so they load the SDK's built `dist/`; the fake hub runs through tsx. useProcesses() kills and
// awaits every process a test started, so none outlives it. A trimmed copy of examples/node-basic/tests/harness.ts.

import type { BreakpointStatus } from "@micafox/protocol";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";

import { ChildProcessRun, readType } from "./child-process-run.js";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");
const HUB_FILE = path.join(EXAMPLE_DIR, "tests", "fake-hub.ts");
// Both the apps and the fake hub print this line
const LISTENING = /^listening on port (\d+)$/;
const QUOTE_MARKER = "// breakpoint here";

/** The timeout of each test: two process starts and a request fit well within it. */
export const E2E_TEST_TIMEOUT_MS = 10_000;

// The id of the one breakpoint each test sets
const BREAKPOINT_ID = "bp-quote";

/** One app of src/: the file node runs and the source file of `quote()`, both relative to the example. */
export interface App {
  readonly name: string;
  readonly entry: string;
  readonly quoteSource: string;
}

/** The apps whose format the SDK supports: plain JavaScript as is, TypeScript as tsc compiled it. */
export const SUPPORTED_APPS: readonly App[] = [
  { name: "cjs", entry: "src/cjs/server.js", quoteSource: "src/cjs/quote.js" },
  { name: "esm", entry: "src/esm/server.js", quoteSource: "src/esm/quote.js" },
  { name: "tsc-cjs", entry: "dist/tsc-cjs/server.js", quoteSource: "src/tsc-cjs/quote.ts" },
  { name: "tsc-esm", entry: "dist/tsc-esm/server.js", quoteSource: "src/tsc-esm/quote.ts" },
];

/** The app esbuild bundled with the SDK into one file: a format the SDK does not support. */
export const BUNDLED_APP: App = {
  name: "bundled",
  entry: "dist/bundled/server.cjs",
  quoteSource: "src/bundled/quote.ts",
};

/** The path of `file` in the repository, as a hub sets a breakpoint on it. */
export const toRepositoryPath = (file: string): string => `examples/module-formats/${file}`;

/**
 * The 1-based line of the return of `quote()` in `app`, found by its marker so edits do not break tests. A lost marker
 * fails here, not as a breakpoint on line 0 that a test would wait on until its timeout.
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

// The developer's own MICAFOX_*, HUB_* and PORT variables never reach the processes: each test sets its own
const createEnvironment = (): Record<string, string> => {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(MICAFOX_|HUB_)/.test(entry[0]) && entry[0] !== "PORT",
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

const start = async (name: string, args: readonly string[], env: Record<string, string>): Promise<ListeningRun> => {
  const run = new ChildProcessRun(name, args, env);
  started.add(run);
  const [line = ""] = await run.waitForLines((candidate) => LISTENING.test(candidate));
  return { run, port: Number(LISTENING.exec(line)?.[1]) };
};

/** Starts the fake hub with one breakpoint on the return of `quote()` in `app`; resolves once it listens. */
export const startHub = (app: App): Promise<ListeningRun> => {
  const breakpoint = { id: BREAKPOINT_ID, file: toRepositoryPath(app.quoteSource), line: findQuoteLine(app) };
  const env = createEnvironment();
  env.HUB_BREAKPOINTS = JSON.stringify([breakpoint]);
  // tsx as an import, so no wrapper process can be orphaned
  return start("fake hub", ["--import", "tsx", HUB_FILE], env);
};

/** Starts `app` connected to the fake hub on `hubPort`; resolves once it serves HTTP. */
export const startApp = (app: App, hubPort: number): Promise<ListeningRun> => {
  const env = createEnvironment();
  env.MICAFOX_HUB_URL = `ws://127.0.0.1:${String(hubPort)}/micafox`;
  return start(`${app.name} app`, [path.join(EXAMPLE_DIR, app.entry)], env);
};

/** The URL of `GET /quote` on the app on `port`. */
export const toQuoteUrl = (port: number): string => `http://127.0.0.1:${String(port)}/quote?sku=SKU-2&quantity=3`;

/** The `breakpointStatus` a line of the fake hub holds; fake-hub.ts prints every message it receives as one line. */
export const readStatus = (line: string): BreakpointStatus | undefined =>
  readType(line) === "breakpointStatus" ? (JSON.parse(line) as BreakpointStatus) : undefined;

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

/** Kills every process a test started after the test, and waits until each has exited. */
export const useProcesses = (): void => {
  // A worker that dies before afterEach still takes its processes along; kill() is synchronous, as `exit` needs
  process.once("exit", () => {
    for (const run of started) {
      run.stop("SIGKILL");
    }
  });
  afterEach(async () => {
    const runs = [...started];
    started.clear();
    for (const run of runs) {
      run.stop("SIGKILL");
    }
    await Promise.all(runs.map((run) => run.exited));
  });
};
