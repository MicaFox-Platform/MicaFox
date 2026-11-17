import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type { AppLoggerName, RecordedLine } from "./app-loggers.js";

const SERVER_FILE = path.join(import.meta.dirname, "server.ts");
// Counted from the answer to `/close`: only a guard against a server that never exits by itself
const EXIT_DEADLINE_MS = 10_000;

/**
 * The timeout of each E2E test. It outlasts the exit deadline, so a server that does not exit is killed and reported
 * through `exitCode`, instead of Vitest timing out first and leaving it running.
 */
export const E2E_TEST_TIMEOUT_MS = EXIT_DEADLINE_MS + 20_000;

/** How one server run is configured; an unset field leaves its variable out of the environment. */
export interface ServerOptions {
  /** The app logger passed as `logger` (`E2E_LOGGER`). */
  logger?: AppLoggerName;
  /** Passed as the `logLevel` option (`E2E_LOG_LEVEL`). */
  logLevel?: string;
  /** `MICAFOX_LOG_LEVEL`. */
  envLogLevel?: string;
}

/** What one server run left behind. */
export interface ServerRun {
  /** `undefined` when a signal ended the process, such as the kill at the exit deadline. */
  exitCode: number | undefined;
  stdout: string[];
  stderr: string[];
}

/** A line of stdout: a request the server got, or a line the recording logger wrote. */
export type StdoutRecord = { step: string } | RecordedLine;

const toLines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

const collect = (stream: NodeJS.ReadableStream | null): (() => string[]) => {
  const chunks: string[] = [];
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => chunks.push(chunk));
  stream?.on("error", () => {
    // A broken pipe shows up as missing lines in the test's assertion
  });
  return () => toLines(chunks.join(""));
};

// `close`, not `exit`: only `close` comes after the child's stdout and stderr have ended
const waitForClose = (child: ChildProcess): Promise<number | undefined> =>
  new Promise((resolve) => {
    child.once("close", (code) => {
      resolve(code ?? undefined);
    });
    // A child that could not be spawned never closes; waitForPort() reports the error
    child.once("error", () => {
      resolve(undefined);
    });
  });

const isPortMessage = (message: unknown): message is { port: number } =>
  typeof message === "object" && message !== null && typeof Reflect.get(message, "port") === "number";

const waitForPort = (child: ChildProcess, stderr: () => string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    child.once("message", (message: unknown) => {
      if (isPortMessage(message)) {
        resolve(message.port);
      } else {
        reject(new Error(`the server sent ${JSON.stringify(message)} instead of its port`));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`the server exited with ${String(code)} before it listened:\n${stderr().join("\n")}`));
    });
  });

const request = async (port: number, route: string): Promise<void> => {
  const response = await fetch(`http://127.0.0.1:${String(port)}${route}`);
  if (!response.ok) {
    throw new Error(`${route} answered ${String(response.status)}`);
  }
};

const toEnvironment = ({ logger, logLevel, envLogLevel }: ServerOptions): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Spawn leaves a variable whose value is `undefined` out, so a MICAFOX_LOG_LEVEL of the shell never leaks in
  env.E2E_LOGGER = logger;
  env.E2E_LOG_LEVEL = logLevel;
  env.MICAFOX_LOG_LEVEL = envLogLevel;
  return env;
};

const startServer = (options: ServerOptions): ChildProcess =>
  // The source condition, as in tests and `pnpm dev`: no build runs before the tests
  spawn(process.execPath, ["--conditions=@micafox/source", "--import", "tsx", SERVER_FILE], {
    cwd: import.meta.dirname,
    env: toEnvironment(options),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

const sendRoutes = async (child: ChildProcess, stderr: () => string[], routes: readonly string[]): Promise<void> => {
  const port = await waitForPort(child, stderr);
  for (const route of [...routes, "/close"]) {
    await request(port, route);
  }
};

const waitForExit = async (child: ChildProcess, closed: Promise<number | undefined>): Promise<number | undefined> => {
  const deadline = setTimeout(() => {
    child.kill("SIGKILL");
  }, EXIT_DEADLINE_MS);
  try {
    return await closed;
  } finally {
    clearTimeout(deadline);
  }
};

/**
 * Starts the fixture server with `options`, sends `routes` one after another, then `/close`, and waits for the
 * process to exit by itself. A run that fails before that kills the server, so none is left running.
 */
export const runServer = async (options: ServerOptions, routes: readonly string[]): Promise<ServerRun> => {
  const child = startServer(options);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const closed = waitForClose(child);

  try {
    await sendRoutes(child, stderr, routes);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  const exitCode = await waitForExit(child, closed);
  return { exitCode, stdout: stdout(), stderr: stderr() };
};

/** Parses the stdout of a run with the recording logger, one JSON object per line. */
export const parseRecords = (stdout: readonly string[]): StdoutRecord[] =>
  stdout.map((line) => JSON.parse(line) as StdoutRecord); // the server writes only these two shapes

/** Keeps the lines the SDK wrote to the console; Node and tsx may write their own warnings to the same streams. */
export const micafoxLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => line.startsWith("[micafox]"));

/** Builds a `/log` route from its query parameters. */
export const logRoute = (params: Readonly<Record<string, string>>): string =>
  `/log?${new URLSearchParams(params).toString()}`;
