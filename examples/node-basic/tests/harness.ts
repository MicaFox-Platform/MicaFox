// Starts the app and the fake hub of this example as real child processes, the way a developer runs them, and reads
// their output line by line. Every wait ends on a line a process prints, or fails at once when the process exits
// first; nothing sleeps. useProcesses() kills and awaits every process a test started, so none outlives it.

import type { Message } from "@probex-platform/protocol";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach } from "vitest";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");
const APP_FILE = path.join(EXAMPLE_DIR, "src", "index.ts");
const HUB_FILE = path.join(EXAMPLE_DIR, "src", "hub", "fake-hub.ts");
const LISTENING = /^listening on port (\d+)$/;

/** The timeout of each test: two process starts and a reconnect fit well within it. */
export const E2E_TEST_TIMEOUT_MS = 10_000;

interface Waiter {
  readonly predicate: (line: string) => boolean;
  readonly count: number;
  readonly resolve: (lines: string[]) => void;
  readonly reject: (error: Error) => void;
}

/** One running app or fake hub. */
export class ChildProcessRun {
  /** Every line of stdout and stderr so far, in arrival order. */
  readonly lines: string[] = [];
  /** Resolves with the exit code once the process has exited and its output has ended; `undefined` after a signal. */
  readonly exited: Promise<number | undefined>;
  private readonly waiters = new Set<Waiter>();
  private hasExited = false;
  private readonly kill: (signal: NodeJS.Signals) => void;

  constructor(
    readonly name: string,
    file: string,
    env: Record<string, string>,
  ) {
    // The source condition, as `pnpm dev` runs the app; tsx as an import, so no wrapper process can be orphaned
    const args = ["--conditions=@probex-platform/source", "--import", "tsx", file];
    const child = spawn(process.execPath, args, { cwd: EXAMPLE_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    this.kill = (signal) => child.kill(signal);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("error", () => {
        // A broken pipe shows up as a missing line, which fails the waiting test with the output so far
      });
      createInterface({ input: stream }).on("line", (line) => {
        this.onLine(line);
      });
    }
    // `close`, not `exit`: only `close` comes after the last line of stdout and stderr
    this.exited = new Promise((resolve) => {
      child.once("close", (code) => {
        this.onExit(code ?? undefined);
        resolve(code ?? undefined);
      });
      child.once("error", () => {
        this.onExit(undefined);
        resolve(undefined);
      });
    });
  }

  /** Resolves with the first `count` lines that match, counting lines already printed. */
  waitForLines(predicate: (line: string) => boolean, count = 1): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { predicate, count, resolve, reject };
      if (!this.settle(waiter)) {
        this.waiters.add(waiter);
      }
    });
  }

  /** Resolves with the first `count` messages of `type` the fake hub printed, counting those already printed. */
  async waitForMessages<T extends Message["type"]>(type: T, count = 1): Promise<Array<Extract<Message, { type: T }>>> {
    const lines = await this.waitForLines((line) => readType(line) === type, count);
    // fake-hub.ts prints every message it receives from the SDK as one JSON line
    return lines.map((line) => JSON.parse(line) as Extract<Message, { type: T }>);
  }

  /** Every message the fake hub printed so far. */
  messages(): Message[] {
    // As in waitForMessages()
    return this.lines.filter((line) => readType(line) !== undefined).map((line) => JSON.parse(line) as Message);
  }

  stop(signal: NodeJS.Signals): void {
    this.kill(signal);
  }

  private onLine(line: string): void {
    this.lines.push(line);
    for (const waiter of this.waiters) {
      if (this.settle(waiter)) {
        this.waiters.delete(waiter);
      }
    }
  }

  private onExit(code: number | undefined): void {
    this.hasExited = true;
    for (const waiter of this.waiters) {
      waiter.reject(this.exitError(code));
    }
    this.waiters.clear();
  }

  private settle(waiter: Waiter): boolean {
    const matches = this.lines.filter((line) => waiter.predicate(line));
    if (matches.length >= waiter.count) {
      waiter.resolve(matches.slice(0, waiter.count));
      return true;
    }

    if (this.hasExited) {
      waiter.reject(this.exitError(undefined));
      return true;
    }

    return false;
  }

  private exitError(code: number | undefined): Error {
    const output = this.lines.join("\n");
    return new Error(`${this.name} exited (code ${String(code)}) before the awaited line; its output:\n${output}`);
  }
}

const readType = (line: string): string | undefined => {
  if (!line.startsWith("{")) {
    return undefined;
  }

  try {
    const message: unknown = JSON.parse(line);
    const type: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "type") : undefined;
    return typeof type === "string" ? type : undefined;
  } catch {
    // Not a message the fake hub printed, such as a stack trace's object dump
    return undefined;
  }
};

// The developer's own PROBEX_*, HUB_* and PORT variables never reach the processes: each test sets its own
const createEnvironment = (): Record<string, string> => {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(PROBEX_|HUB_)/.test(entry[0]) && entry[0] !== "PORT",
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

const start = async (name: string, file: string, env: Record<string, string>): Promise<ListeningRun> => {
  const run = new ChildProcessRun(name, file, env);
  started.add(run);
  const [line = ""] = await run.waitForLines((candidate) => LISTENING.test(candidate));
  return { run, port: Number(LISTENING.exec(line)?.[1]) };
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
  return start("fake hub", HUB_FILE, env);
};

/** How the app is started; each field is unset by default. */
export interface AppOptions {
  /** `PORT`; a free port by default. */
  port?: number;
  /** `PROBEX_HUB_URL` for the fake hub on this port. */
  hubPort?: number;
  /** `PROBEX_TOKEN`. */
  token?: string;
  /** `PROBEX_SERVICE`. */
  service?: string;
  /** `PROBEX_LABELS`, such as `team=payments,region=eu`. */
  labels?: string;
}

/** Starts the app; resolves once it serves HTTP. */
export const startApp = (options: AppOptions = {}): Promise<ListeningRun> => {
  const env = createEnvironment();
  if (options.port !== undefined) {
    env.PORT = String(options.port);
  }
  if (options.hubPort !== undefined) {
    env.PROBEX_HUB_URL = `ws://127.0.0.1:${String(options.hubPort)}/probex`;
  }
  if (options.token !== undefined) {
    env.PROBEX_TOKEN = options.token;
  }
  if (options.service !== undefined) {
    env.PROBEX_SERVICE = options.service;
  }
  if (options.labels !== undefined) {
    env.PROBEX_LABELS = options.labels;
  }
  return start("app", APP_FILE, env);
};

/** The URL of `route` on the app on `port`. */
export const toAppUrl = (port: number, route: string): string => `http://127.0.0.1:${String(port)}${route}`;

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
