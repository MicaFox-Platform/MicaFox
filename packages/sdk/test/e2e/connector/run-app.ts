import type { Message } from "@micafox/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import type { HubConnectorOptions } from "../../../src/connector/index.js";

const APP_FILE = path.join(import.meta.dirname, "app.ts");
// Only a guard against an app that never exits by itself
const EXIT_DEADLINE_MS = 15_000;

/**
 * The timeout of each E2E test. It outlasts the exit deadline, so an app that does not exit is killed and reported
 * through `exitCode`, instead of Vitest timing out first and leaving it running.
 */
export const E2E_TEST_TIMEOUT_MS = EXIT_DEADLINE_MS + 15_000;

/** What one app run left behind. */
export interface AppRun {
  /** `undefined` when a signal ended the process, such as the kill at the exit deadline. */
  exitCode: number | undefined;
  /** The statuses the connector reported, in order. */
  statuses: string[];
  stderr: string[];
}

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

const readStatus = (line: string): string => {
  const record: unknown = JSON.parse(line);
  const status: unknown = typeof record === "object" && record !== null ? Reflect.get(record, "status") : undefined;
  return typeof status === "string" ? status : `<not a status: ${line}>`;
};

// `close`, not `exit`: only `close` comes after the child's stdout and stderr have ended
const waitForClose = (child: ChildProcess): Promise<number | undefined> =>
  new Promise((resolve) => {
    child.once("close", (code) => {
      resolve(code ?? undefined);
    });
    child.once("error", () => {
      resolve(undefined);
    });
  });

/** How one app run is configured. */
export interface AppOptions {
  /** `MICAFOX_HUB_URL`. */
  hubUrl: string;
  /** `NODE_EXTRA_CA_CERTS`. */
  extraCaCerts?: string;
  /** `E2E_HOLD_UNTIL`: the status the app keeps itself alive for. */
  holdUntil?: string;
  /** `E2E_SEND`: the messages the app sends once `holdUntil` is reported. */
  send?: Message[];
  /** `E2E_CLOSE`: whether the app calls close() right after it sends. */
  shouldClose?: boolean;
  /** `E2E_CONNECTOR_OPTIONS`: more HubConnector options, such as `batch`. */
  connectorOptions?: HubConnectorOptions;
}

const toJson = (value: unknown): string | undefined => (value === undefined ? undefined : JSON.stringify(value));

const toEnvironment = (options: AppOptions): NodeJS.ProcessEnv => {
  const { hubUrl, extraCaCerts, holdUntil, send, shouldClose, connectorOptions } = options;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Spawn leaves a variable whose value is `undefined` out, so the shell's MICAFOX_* variables never leak in
  env.MICAFOX_TOKEN = undefined;
  env.MICAFOX_LOG_LEVEL = undefined;
  env.MICAFOX_HUB_URL = hubUrl;
  env.NODE_EXTRA_CA_CERTS = extraCaCerts;
  env.E2E_HOLD_UNTIL = holdUntil;
  env.E2E_SEND = toJson(send);
  env.E2E_CLOSE = shouldClose === true ? "1" : undefined;
  env.E2E_CONNECTOR_OPTIONS = toJson(connectorOptions);
  return env;
};

/** Starts the fixture app configured by `options` and waits for it to exit by itself. */
export const runApp = async (options: AppOptions): Promise<AppRun> => {
  // The source condition, as in tests and `pnpm dev`: no build runs before the tests. ipv6first makes localhost try
  // ::1 before the hub's 127.0.0.1 on every OS, as Linux does, so the fallback to the next address is always tested.
  const args = ["--conditions=@micafox/source", "--dns-result-order=ipv6first", "--import", "tsx", APP_FILE];
  const child = spawn(process.execPath, args, {
    cwd: import.meta.dirname,
    env: toEnvironment(options),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const deadline = setTimeout(() => {
    child.kill("SIGKILL");
  }, EXIT_DEADLINE_MS);
  try {
    const exitCode = await waitForClose(child);
    return { exitCode, statuses: stdout().map((line) => readStatus(line)), stderr: stderr() };
  } finally {
    clearTimeout(deadline);
  }
};
