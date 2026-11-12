// One child process of the e2e tests, read line by line: every wait ends on a line it prints, or fails at once when it
// exits first; nothing sleeps. A copy of examples/module-formats/tests/child-process-run.ts whose lines have no colour
// codes and whose exit reports the signal that ended the process.

import type { Message } from "@micafox/protocol";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");

/** How a process ended: its exit code, the signal that ended it, or `undefined` when it could not start. */
export type Exit = number | NodeJS.Signals | undefined;

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
  /** Resolves once the process has exited and its output has ended: with its exit code, or the signal that ended it. */
  readonly exited: Promise<Exit>;
  private readonly waiters = new Set<Waiter>();
  private hasExited = false;
  private readonly kill: (signal: NodeJS.Signals) => void;

  /** Runs `node <args>`: no export condition, so `@micafox/sdk` resolves to its built `dist/`. */
  constructor(
    readonly name: string,
    args: readonly string[],
    env: Record<string, string>,
  ) {
    const child = spawn(process.execPath, args, { cwd: EXAMPLE_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    this.kill = (signal) => child.kill(signal);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("error", () => {
        // A broken pipe shows up as a missing line, which fails the waiting test with the output so far
      });
      createInterface({ input: stream }).on("line", (line) => {
        // Next.js colours its output; no test waits on a colour
        this.onLine(stripVTControlCharacters(line));
      });
    }
    // `close`, not `exit`: only `close` comes after the last line of stdout and stderr
    this.exited = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        const exit = code ?? signal ?? undefined;
        this.onExit(exit);
        resolve(exit);
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

  private onExit(exit: Exit): void {
    this.hasExited = true;
    for (const waiter of this.waiters) {
      waiter.reject(this.exitError(exit));
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

  private exitError(exit: Exit): Error {
    const output = this.lines.join("\n");
    return new Error(`${this.name} exited (${String(exit)}) before the awaited line; its output:\n${output}`);
  }
}

// The object a line holds as JSON: a message the fake hub printed
const parseJsonLine = (line: string): object | undefined => {
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

/** The `type` of a message the fake hub printed. */
export const readType = (line: string): string | undefined => {
  const message = parseJsonLine(line);
  const type: unknown = message === undefined ? undefined : Reflect.get(message, "type");
  return typeof type === "string" ? type : undefined;
};
