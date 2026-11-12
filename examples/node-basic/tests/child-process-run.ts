// One child process of the e2e tests, read line by line: every wait ends on a line it prints, or fails at once when it
// exits first; nothing sleeps.

import type { Message } from "@micafox/protocol";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");

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
    const args = ["--conditions=@micafox/source", "--import", "tsx", file];
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

/** The object a line holds as JSON: a message the fake hub printed or a line of the app's pino. */
export const parseJsonLine = (line: string): object | undefined => {
  if (!line.startsWith("{")) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    // Not JSON, such as a stack trace's object dump
    return undefined;
  }
};

/** The `type` of a message the fake hub printed; pino lines have none. */
export const readType = (line: string): string | undefined => {
  const message = parseJsonLine(line);
  const type: unknown = message === undefined ? undefined : Reflect.get(message, "type");
  return typeof type === "string" ? type : undefined;
};
