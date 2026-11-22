import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { get } from "../../../../test/server/http.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import { createApp } from "../../app/index.js";
import type { HubApp } from "../../app/index.js";
import { registerHealth } from "../health.js";
import type { Phase } from "../health.js";
import { createShutdown } from "../shutdown.js";
import type { Clock, StopHook, StopResult } from "../shutdown.js";

// Timers and the clock are faked; the sockets stay real, since draining is about open connections
const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

const createGate = (): Gate => {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    promise,
    open: () => {
      open();
    },
  };
};

interface Setup {
  app: HubApp;
  hooks: StopHook[];
  events: string[];
  log: ReturnType<typeof captureLog>;
  url: string;
  stop: () => Promise<StopResult>;
  slowRequest: Gate;
  /** Opens when the slow route has been entered, so a test stops the hub with a request really running. */
  requestRunning: Gate;
}

const setup = async (options: { failOnClose?: boolean } = {}): Promise<Setup> => {
  const log = captureLog();
  const { default: pino } = await import("pino");
  const app = createApp({ logger: pino({}, log.stream), trustProxy: false, publicUrl: undefined, version: "1.2.3" });
  let phase: Phase = "ready";
  registerHealth(app, () => phase);
  if (options.failOnClose === true) {
    app.addHook("onClose", () => Promise.reject(new Error("a plugin failed to close")));
  }
  const slowRequest = createGate();
  const requestRunning = createGate();
  const events: string[] = [];
  app.get("/slow", async () => {
    requestRunning.open();
    await slowRequest.promise;
    events.push("handler finished");
    return "finished";
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const hooks: StopHook[] = [];
  const runShutdown = createShutdown({ app, hooks: () => hooks, log: pino({}, log.stream), clock });
  const stop = async (): Promise<StopResult> => {
    phase = "stopping";
    return await runShutdown();
  };
  const url = `http://127.0.0.1:${String(app.addresses()[0]?.port)}`;
  return { app, hooks, events, log, url, stop, slowRequest, requestRunning };
};

const hook = (name: string, phase: StopHook["phase"], run: () => Promise<void>): StopHook => ({ name, phase, run });

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise((resolve) => setImmediate(resolve));
};

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a running request finish, then runs the hooks in the order they were added", async () => {
    const { hooks, events, url, stop, slowRequest, requestRunning } = await setup();
    hooks.push(
      hook("queue", "after-drain", () => {
        events.push("hook queue");
        return Promise.resolve();
      }),
      hook("pool", "after-drain", () => {
        events.push("hook pool");
        return Promise.resolve();
      }),
    );
    const request = get(url, "/slow");
    await requestRunning.promise;

    const stopping = stop();
    await flush();
    events.push("still draining");
    slowRequest.open();

    await expect(stopping).resolves.toEqual({ clean: true });
    await expect(request).resolves.toMatchObject({ status: 200, body: "finished" });
    expect(events).toEqual(["still draining", "handler finished", "hook queue", "hook pool"]);
  });

  it("runs a before-drain hook while the request is still running", async () => {
    const { hooks, events, url, stop, slowRequest, requestRunning } = await setup();
    hooks.push(
      hook("sockets", "before-drain", () => {
        events.push("hook sockets");
        return Promise.resolve();
      }),
    );
    const request = get(url, "/slow");
    await requestRunning.promise;

    const stopping = stop();
    await flush();
    slowRequest.open();

    await stopping;
    await request;
    expect(events).toEqual(["hook sockets", "handler finished"]);
  });

  it("closes the connection of a request that outlasts 10 s and still ends cleanly", async () => {
    const { url, stop, log, slowRequest, requestRunning } = await setup();
    const outcome = get(url, "/slow").then(
      () => "response",
      () => "connection closed",
    );
    await requestRunning.promise;

    const stopping = stop();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(stopping).resolves.toEqual({ clean: true });
    await expect(outcome).resolves.toBe("connection closed");
    expect(log.lines()).toContainEqual(expect.objectContaining({ level: 40 }));
    slowRequest.open();
  });

  it("gives a hook that never ends 10 s, logs it, and runs the hooks after it", async () => {
    const { hooks, events, stop, log } = await setup();
    hooks.push(
      hook("stuck", "after-drain", () => new Promise<void>(() => undefined)),
      hook("pool", "after-drain", () => {
        events.push("hook pool");
        return Promise.resolve();
      }),
    );

    const stopping = stop();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(stopping).resolves.toEqual({ clean: false });
    expect(events).toEqual(["hook pool"]);
    expect(log.lines()).toContainEqual(expect.objectContaining({ hook: "stuck", msg: "A stop hook ran out of time" }));
  });

  it("logs a hook that throws, runs the rest and reports an unclean stop", async () => {
    const { hooks, events, stop, log } = await setup();
    hooks.push(
      hook("queue", "after-drain", () => Promise.reject(new Error("disk full"))),
      hook("pool", "after-drain", () => {
        events.push("hook pool");
        return Promise.resolve();
      }),
    );

    await expect(stop()).resolves.toEqual({ clean: false });

    expect(events).toEqual(["hook pool"]);
    expect(log.lines()).toContainEqual(expect.objectContaining({ hook: "queue", msg: "A stop hook failed" }));
  });

  it("ends within 25 s even when the hooks and the drain use their whole time", async () => {
    const { hooks, url, stop, slowRequest, requestRunning } = await setup();
    hooks.push(
      hook("before", "before-drain", () => new Promise<void>(() => undefined)),
      hook("after", "after-drain", () => new Promise<void>(() => undefined)),
    );
    const outcome = get(url, "/slow").then(
      () => "response",
      () => "connection closed",
    );
    await requestRunning.promise;

    const stopping = stop();
    let isDone = false;
    void stopping.then(() => {
      isDone = true;
    });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(isDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(stopping).resolves.toEqual({ clean: false });
    await expect(outcome).resolves.toBe("connection closed");
    slowRequest.open();
  });
  it("closes a keep-alive connection once its running request is answered, without waiting for the drain time", async () => {
    const { url, stop, log, slowRequest, requestRunning } = await setup();
    const agent = new http.Agent({ keepAlive: true });
    const request = get(url, "/slow", agent);
    await requestRunning.promise;

    const stopping = stop();
    await flush();
    slowRequest.open();

    await expect(request).resolves.toMatchObject({ status: 200, connection: "close" });
    await expect(stopping).resolves.toEqual({ clean: true });
    expect(log.lines()).not.toContainEqual(expect.objectContaining({ level: 40 }));
    agent.destroy();
  });

  it("still runs the hooks after the drain when the server fails to close, and reports an unclean stop", async () => {
    const { hooks, events, stop, log } = await setup({ failOnClose: true });
    hooks.push(
      hook("pool", "after-drain", () => {
        events.push("hook pool");
        return Promise.resolve();
      }),
    );

    await expect(stop()).resolves.toEqual({ clean: false });

    expect(events).toEqual(["hook pool"]);
    expect(log.lines()).toContainEqual(expect.objectContaining({ msg: "The server failed to close" }));
  });
});
