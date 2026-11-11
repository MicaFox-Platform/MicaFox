// Helpers for tests that run against the real V8 inspector of the test process: fixture modules loaded from disk
// and a session that records what crosses the boundary.

import type { BreakpointStatus, Snapshot } from "@micafox/protocol";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createRecordingLogger, type LoggedLine } from "./fakes.js";
import { Breakpoints } from "../../src/debugger/breakpoints/index.js";
import { InspectorSession, type InspectorBinding } from "../../src/debugger/index.js";
import { Pauses } from "../../src/debugger/pauses/index.js";
import { RateLimiter } from "../../src/debugger/rate-limiter/index.js";
import { createLogger, type SdkLogger } from "../../src/logger/index.js";

/**
 * A module with a loop; its lines are what the tests set breakpoints on:
 * 1 function, 2 `let sum`, 3 `for`, 4 `sum += `, 5 `}`, 6 `return`.
 */
export const CHECKOUT_SOURCE = `exports.total = function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
};
`;

/** A module whose function pauses at a `debugger` statement. */
export const DEBUGGER_STATEMENT_SOURCE = `exports.pause = function pause() {
  debugger;
  return 1;
};
`;

/** Returns what `exports.total` of a checkout module returned for two items. */
export const TOTAL_OF_TWO_ITEMS = 30;

export const TWO_ITEMS = [{ price: 10 }, { price: 20 }];

/** What a fixture module exports. */
export interface CheckoutModule {
  total: (items: Array<{ price: number }>) => number;
}

export interface PauseModule {
  pause: () => number;
}

/**
 * A directory of CommonJS modules that Node loads itself, so that V8 reports them without a source map. A module
 * stays alive in V8 after its test, so every file name carries a tag that is unique to the instance: a later test
 * never matches a file of an earlier one.
 */
export class Fixtures {
  private readonly dir = realpathSync(mkdtempSync(path.join(tmpdir(), "micafox-fixtures-")));
  private readonly tag = randomUUID().slice(0, 8);
  private readonly require = createRequire(import.meta.url);

  /** The path a hub would send for the fixture `relative`, such as `orders/checkout-1a2b3c4d.cjs`. */
  file(relative: string): string {
    const { dir, name, ext } = path.parse(relative);
    return path.posix.join(dir, `${name}-${this.tag}${ext}`);
  }

  /** Writes `source` to the fixture `relative` and returns its absolute path. */
  write(relative: string, source: string): string {
    const file = path.join(this.dir, this.file(relative));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
    return file;
  }

  /** Loads a checkout module; a second call after `unload()` loads it again, as a new script with the same URL. */
  loadCheckout(file: string): CheckoutModule {
    // The fixture source above is what the module exports
    return this.require(file) as CheckoutModule;
  }

  loadPause(file: string): PauseModule {
    return this.require(file) as PauseModule;
  }

  unload(file: string): void {
    // The module cache is how a test loads the same file again
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.require.cache[file];
  }

  urlOf(file: string): string {
    return pathToFileURL(file).href;
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

type InspectorListener = Parameters<InspectorBinding["on"]>[1];

/** A real `node:inspector` session that records the commands sent and the pauses, and can fail chosen commands. */
export class TracedSession implements InspectorBinding {
  readonly posted: Array<{ method: string; params: object | undefined }> = [];
  /** The `hitBreakpoints` of every `Debugger.paused`, in order. */
  readonly pauses: string[][] = [];
  /** Commands answered with an error without reaching V8. */
  readonly failing = new Set<string>();
  /** Commands answered with a fixed result without reaching V8. */
  readonly answers = new Map<string, object>();
  /** Runs before each command reaches V8, to observe the state the debugger is in when it sends it. */
  beforePost: (method: string) => void = () => undefined;
  private readonly session = new Session();

  /** Pauses that no listener resumed, which the safety net resumed instead of leaving the test process hung. */
  unhandledPauses = 0;
  private resumesAtPause = 0;

  /** The methods posted so far. */
  get methods(): string[] {
    return this.posted.map(({ method }) => method);
  }

  count(method: string): number {
    return this.methods.filter((posted) => posted === method).length;
  }

  connect(): void {
    this.session.connect();
    // Registered before the debugger's own listener, so a pause is recorded before it is resumed
    this.session.on("Debugger.paused", (message: { params: { hitBreakpoints?: string[] } }) => {
      this.pauses.push(message.params.hitBreakpoints ?? []);
      this.resumesAtPause = this.count("Debugger.resume");
    });
  }

  /** Adds a last listener that resumes a pause nobody resumed, so a test of a missing handler fails, not hangs. */
  addSafetyNet(): void {
    this.session.on("Debugger.paused", () => {
      if (this.count("Debugger.resume") === this.resumesAtPause) {
        this.unhandledPauses += 1;
        this.session.post("Debugger.resume");
      }
    });
  }

  disconnect(): void {
    this.session.disconnect();
  }

  post(method: string, params: object | undefined, callback: (error: Error | null, result?: object) => void): void {
    this.posted.push({ method, params });
    this.beforePost(method);
    if (this.failing.has(method)) {
      callback(new Error(`${method} failed`));
      return;
    }

    const answer = this.answers.get(method);
    if (answer !== undefined) {
      callback(null, answer);
      return;
    }

    this.session.post(method, params, callback);
  }

  on(event: string, listener: InspectorListener): unknown {
    return this.session.on(event, listener);
  }

  off(event: string, listener: InspectorListener): unknown {
    return this.session.off(event, listener);
  }
}

/**
 * A `Breakpoints` and its `Pauses` on a real inspector session, with the statuses and snapshots they sent and the
 * failures they reported. The rate limits run on `Date.now()`, which fake timers control.
 */
export interface BreakpointsUnderTest {
  breakpoints: Breakpoints;
  pauses: Pauses;
  session: TracedSession;
  fixtures: Fixtures;
  sent: BreakpointStatus[];
  snapshots: Snapshot[];
  failures: unknown[];
  lines: LoggedLine[];
  /** Delivers a `breakpoints` message with `entries`. */
  apply: (...entries: unknown[]) => void;
  /** The messages logged at `level`. */
  messagesAt: (level: LoggedLine["level"]) => string[];
  /** Resolves when a line at `level` starting with `prefix` is logged, after the call that logged it returns. */
  waitForLine: (level: LoggedLine["level"], prefix: string) => Promise<void>;
  /** Stops the breakpoints, disconnects the session and deletes the fixtures. */
  dispose: () => void;
}

// Resolves a wait when its line is logged; the promise settles after the call that logged it returns
const createLineWaiters = (): {
  onLine: (line: LoggedLine) => void;
  waitForLine: BreakpointsUnderTest["waitForLine"];
} => {
  const waiters: Array<{ level: LoggedLine["level"]; prefix: string; resolve: () => void }> = [];
  return {
    onLine: (line) => {
      for (const waiter of waiters.filter(
        ({ level, prefix }) => line.level === level && line.message.startsWith(prefix),
      )) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    waitForLine: (level, prefix) =>
      new Promise((resolve) => {
        waiters.push({ level, prefix, resolve });
      }),
  };
};

// Breakpoints and Pauses wired as the debugger wires them, recording what they send and report
const createParts = (inspector: InspectorSession, logger: SdkLogger, isSecret: (name: string) => boolean) => {
  const sent: BreakpointStatus[] = [];
  const snapshots: Snapshot[] = [];
  const failures: unknown[] = [];
  const fail = (error: unknown): void => {
    failures.push(error);
  };
  const now = (): number => Date.now();
  const limiter = new RateLimiter(now);
  const breakpoints = new Breakpoints({
    session: inspector,
    logger,
    send: (status) => {
      sent.push(status);
    },
    fail,
    onRemoved: (id) => {
      limiter.forget(id);
    },
  });
  const pauses = new Pauses({
    session: inspector,
    logger,
    breakpoints,
    limiter,
    isSecret,
    send: (snapshot) => {
      snapshots.push(snapshot);
    },
    fail,
    now,
  });
  return { sent, snapshots, failures, breakpoints, pauses };
};

/** `isSecret` defaults to redacting `password`; one that throws makes the capture fail. */
export const createBreakpoints = (options: { isSecret?: (name: string) => boolean } = {}): BreakpointsUnderTest => {
  const lines: LoggedLine[] = [];
  const { onLine, waitForLine } = createLineWaiters();
  const logger = createLogger({ component: "debugger", env: {}, console: createRecordingLogger(lines, onLine) });
  logger.set({ logLevel: "debug" }, "debugger");
  const traced = new TracedSession();
  const inspector = new InspectorSession(logger, traced);
  inspector.connect();
  const { sent, snapshots, failures, breakpoints, pauses } = createParts(
    inspector,
    logger,
    options.isSecret ?? ((name) => name === "password"),
  );
  breakpoints.start();
  pauses.start();
  const fixtures = new Fixtures();

  return {
    breakpoints,
    pauses,
    session: traced,
    fixtures,
    sent,
    snapshots,
    failures,
    lines,
    apply: (...entries) => {
      breakpoints.apply({ version: 1, type: "breakpoints", breakpoints: entries });
    },
    messagesAt: (level) => lines.filter((line) => line.level === level).map((line) => line.message),
    waitForLine,
    dispose: () => {
      breakpoints.stop();
      pauses.stop();
      inspector.disconnect();
      fixtures.remove();
    },
  };
};
