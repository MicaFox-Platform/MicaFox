// Starts the app and the fake hub of this example as real child processes, the way a developer runs them, and waits
// on what they print. useProcesses() kills and awaits every process a test started, so none outlives it.

import type { BreakpointStatus } from "@micafox/protocol";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";

import { ChildProcessRun, parseJsonLine, readType } from "./child-process-run.js";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");
const APP_FILE = path.join(EXAMPLE_DIR, "src", "index.ts");
const HUB_FILE = path.join(EXAMPLE_DIR, "src", "hub", "fake-hub.ts");
const PRICING_FILE = path.join(EXAMPLE_DIR, "src", "pricing.ts");
const PRICING_MARKER = "// breakpoint here";
// The fake hub prints this line; the app's Fastify logs `Server listening at http://127.0.0.1:<port>` through pino
const HUB_LISTENING = /^listening on port (\d+)$/;
const APP_LISTENING = /"msg":"Server listening at http:\/\/127\.0\.0\.1:(\d+)"/;

/** The 1-based line of the return of `quote()` in `src/pricing.ts`, found by its marker so edits do not break tests. */
export const PRICING_LINE =
  readFileSync(PRICING_FILE, "utf8")
    .split("\n")
    .findIndex((line) => line.includes(PRICING_MARKER)) + 1;

/** The timeout of each test: two process starts and a reconnect fit well within it. */
export const E2E_TEST_TIMEOUT_MS = 10_000;

// The developer's own MICAFOX_*, HUB_*, PORT and PRICING_API_KEY variables never reach the processes: each test sets
// its own
const createEnvironment = (): Record<string, string> => {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(MICAFOX_|HUB_)/.test(entry[0]) && !["PORT", "PRICING_API_KEY"].includes(entry[0]),
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

interface StartOptions {
  readonly name: string;
  readonly file: string;
  readonly env: Record<string, string>;
  readonly listening: RegExp;
}

const start = async ({ name, file, env, listening }: StartOptions): Promise<ListeningRun> => {
  const run = new ChildProcessRun(name, file, env);
  started.add(run);
  const [line = ""] = await run.waitForLines((candidate) => listening.test(candidate));
  return { run, port: Number(listening.exec(line)?.[1]) };
};

/** How the fake hub is started; each field is unset by default. */
export interface HubOptions {
  /** `PORT`; a free port by default. */
  port?: number;
  /** `HUB_TOKEN`. */
  token?: string;
  /** `HUB_BREAKPOINTS`, as JSON. */
  breakpoints?: unknown[];
}

/** Starts the fake hub; resolves once it listens. */
export const startHub = (options: HubOptions = {}): Promise<ListeningRun> => {
  const env = createEnvironment();
  if (options.port !== undefined) {
    env.PORT = String(options.port);
  }
  if (options.token !== undefined) {
    env.HUB_TOKEN = options.token;
  }
  if (options.breakpoints !== undefined) {
    env.HUB_BREAKPOINTS = JSON.stringify(options.breakpoints);
  }
  return start({ name: "fake hub", file: HUB_FILE, env, listening: HUB_LISTENING });
};

/** How the app is started; each field is unset by default. */
export interface AppOptions {
  /** `PORT`; a free port by default. */
  port?: number;
  /** `MICAFOX_HUB_URL` for the fake hub on this port. */
  hubPort?: number;
  /** `MICAFOX_TOKEN`. */
  token?: string;
  /** `MICAFOX_SERVICE`. */
  service?: string;
  /** `MICAFOX_LABELS`, such as `team=payments,region=eu`. */
  labels?: string;
  /** `MICAFOX_ENABLED`. */
  enabled?: string;
  /** `MICAFOX_LOG_LEVEL`. */
  logLevel?: string;
  /** `PRICING_API_KEY`, the secret of `src/pricing.ts`. */
  pricingApiKey?: string;
}

const APP_VARIABLES: ReadonlyArray<[keyof AppOptions, string]> = [
  ["token", "MICAFOX_TOKEN"],
  ["service", "MICAFOX_SERVICE"],
  ["labels", "MICAFOX_LABELS"],
  ["enabled", "MICAFOX_ENABLED"],
  ["logLevel", "MICAFOX_LOG_LEVEL"],
  ["pricingApiKey", "PRICING_API_KEY"],
];

/** Starts the app; resolves once it serves HTTP. */
export const startApp = (options: AppOptions = {}): Promise<ListeningRun> => {
  const env = createEnvironment();
  if (options.port !== undefined) {
    env.PORT = String(options.port);
  }
  if (options.hubPort !== undefined) {
    env.MICAFOX_HUB_URL = `ws://127.0.0.1:${String(options.hubPort)}/micafox`;
  }
  for (const [option, variable] of APP_VARIABLES) {
    const value = options[option];
    if (value !== undefined) {
      env[variable] = String(value);
    }
  }
  return start({ name: "app", file: APP_FILE, env, listening: APP_LISTENING });
};

/** The URL of `route` on the app on `port`. */
export const toAppUrl = (port: number, route: string): string => `http://127.0.0.1:${String(port)}${route}`;

/** The `msg` of a line the app's pino printed; `undefined` for any other line. */
export const readLogMessage = (line: string): string | undefined => {
  const message = parseJsonLine(line);
  const text: unknown = message === undefined ? undefined : Reflect.get(message, "msg");
  return typeof text === "string" ? text : undefined;
};

/** Resolves with the first line the app's pino printed whose message contains `text`. */
export const waitForLog = async (run: ChildProcessRun, text: string): Promise<string> => {
  const [line = ""] = await run.waitForLines((candidate) => readLogMessage(candidate)?.includes(text) === true);
  return line;
};

/** Resolves with the first `breakpointStatus` the fake hub printed for `breakpointId` that `isWanted` accepts. */
export const waitForStatus = async (
  hub: ChildProcessRun,
  breakpointId: string,
  isWanted: (status: BreakpointStatus) => boolean = () => true,
): Promise<BreakpointStatus> => {
  const [line = ""] = await hub.waitForLines((candidate) => {
    const status = readStatus(candidate);
    return status?.breakpointId === breakpointId && isWanted(status);
  });
  // readStatus() has accepted the line as a breakpointStatus
  return JSON.parse(line) as BreakpointStatus;
};

// The breakpointStatus a line of the fake hub holds; fake-hub.ts prints every message it receives as one JSON line
const readStatus = (line: string): BreakpointStatus | undefined =>
  readType(line) === "breakpointStatus" ? (JSON.parse(line) as BreakpointStatus) : undefined;

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
