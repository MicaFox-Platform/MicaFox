import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envOf, TEST_MODE_LINES } from "../../../../test/server/env.js";
import { get, openSlowRequest } from "../../../../test/server/http.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import type { RunHubProcess } from "../index.js";
import { runHub } from "../run-hub.js";

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

interface Fixture {
  proc: RunHubProcess;
  signal: (name: "SIGTERM" | "SIGINT") => void;
  exits: number[];
  exited: Promise<number>;
  log: ReturnType<typeof captureLog>;
  stderr: () => string;
}

const createProcess = (lines: readonly string[]): Fixture => {
  const log = captureLog();
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const errors: string[] = [];
  let exitProcess: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    exitProcess = resolve;
  });
  const proc: RunHubProcess = {
    env: envOf(lines),
    stdout: log.stream,
    stderr: {
      write: (text) => {
        errors.push(text);
      },
    },
    on: (signal, listener) => handlers.set(signal, listener),
    exit: (code) => {
      exits.push(code);
      exitProcess(code);
    },
  };
  return {
    proc,
    exits,
    exited,
    log,
    stderr: () => errors.join(""),
    signal: (name) => {
      handlers.get(name)?.();
    },
  };
};

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise((resolve) => setImmediate(resolve));
};

const urlOf = (log: Fixture["log"]): string => {
  const started = log.lines().find((line) => line.msg === "hub.started");
  return (started?.settings as { publicUrl: string }).publicUrl;
};

describe("runHub", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints every settings problem at once, exits with 1 and starts nothing", async () => {
    const { proc, exits, stderr, log } = createProcess([
      "MICAFOX_PORT=70000",
      "MICAFOX_LOG_LEVEL=trace",
      "MICAFOX_DATABASE_URL=mysql://app:hunter2@db/hub",
    ]);

    await runHub({ version: "1", build: "hub", features: [] }, proc);

    expect(exits).toEqual([1]);
    expect(stderr()).toContain("MICAFOX_PUBLIC_URL: required");
    expect(stderr()).toContain("MICAFOX_PORT: must be an integer");
    expect(stderr()).toContain("MICAFOX_LOG_LEVEL: must be one of");
    expect(stderr()).toContain("MICAFOX_DATABASE_URL: must be a postgres:// URL");
    expect(stderr()).not.toContain("hunter2");
    expect(log.text()).toBe("");
  });

  it("stops on SIGTERM: /readyz turns 503, a running request is answered, the hooks run in order, exit 0", async () => {
    const { proc, signal, exited, log } = createProcess(TEST_MODE_LINES);
    const hold = createGate();
    const order: string[] = [];
    await runHub(
      {
        version: "1",
        build: "hub",
        features: ["debugger"],
        configure: (hub) => {
          hub.addStopHook(
            "streams",
            async () => {
              await hold.promise;
              order.push("streams");
            },
            { phase: "before-drain" },
          );
          hub.addStopHook("pool", () => {
            order.push("pool");
            return Promise.resolve();
          });
        },
      },
      proc,
    );
    const url = urlOf(log);
    const running = await openSlowRequest(url, "/healthz");

    signal("SIGTERM");
    await flush();

    await expect(get(url, "/readyz")).resolves.toMatchObject({ status: 503 });
    await expect(running.finish()).resolves.toMatchObject({ status: 200, headers: { connection: "close" } });
    await running.closed;
    hold.open();
    await expect(exited).resolves.toBe(0);
    expect(order).toEqual(["streams", "pool"]);
    expect(log.lines().map((line) => line.msg)).toContain("hub.stopped");
  });

  it("stops on SIGINT too", async () => {
    const { proc, signal, exited } = createProcess(TEST_MODE_LINES);
    await runHub({ version: "1", build: "hub", features: [] }, proc);

    signal("SIGINT");

    await expect(exited).resolves.toBe(0);
  });

  it("exits with 1 at once on a second signal, while the first stop still waits for a hook", async () => {
    const { proc, signal, exits } = createProcess(TEST_MODE_LINES);
    const hold = createGate();
    await runHub(
      {
        version: "1",
        build: "hub",
        features: [],
        configure: (hub) => {
          hub.addStopHook("flush", () => hold.promise, { phase: "before-drain" });
        },
      },
      proc,
    );

    signal("SIGTERM");
    await flush();
    expect(exits).toEqual([]);
    signal("SIGTERM");

    expect(exits).toEqual([1]);
    hold.open();
  });

  it("exits with 1 when a stop hook runs out of its time", async () => {
    const { proc, signal, exited } = createProcess(TEST_MODE_LINES);
    await runHub(
      {
        version: "1",
        build: "hub",
        features: [],
        configure: (hub) => {
          hub.addStopHook("stuck", () => new Promise<void>(() => undefined));
        },
      },
      proc,
    );

    signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(exited).resolves.toBe(1);
  });

  it("exits with 0 after a stop that ran its slow hook to the end", async () => {
    const { proc, signal, exited } = createProcess(TEST_MODE_LINES);
    const hold = createGate();
    const order: string[] = [];
    await runHub(
      {
        version: "1",
        build: "hub",
        features: [],
        configure: (hub) => {
          hub.addStopHook("slow", async () => {
            await hold.promise;
            order.push("slow hook done");
          });
          hub.addStopHook("last", () => {
            order.push("last hook");
            return Promise.resolve();
          });
        },
      },
      proc,
    );

    signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(9_000);
    hold.open();

    await expect(exited).resolves.toBe(0);
    expect(order).toEqual(["slow hook done", "last hook"]);
  });
});

describe("runHub when the hub cannot start", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs the error and exits with 1 when the port is taken", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as net.AddressInfo;
    const { proc, exited, log } = createProcess([
      "MICAFOX_TEST_MODE=true",
      "MICAFOX_DATABASE_URL=pglite:memory",
      "MICAFOX_HOST=127.0.0.1",
      `MICAFOX_PORT=${String(port)}`,
    ]);

    await runHub({ version: "1", build: "hub", features: [] }, proc);

    await expect(exited).resolves.toBe(1);
    expect(log.lines()).toContainEqual(expect.objectContaining({ msg: "The hub could not start", level: "error" }));
    await new Promise((resolve) => taken.close(resolve));
  });

  it("logs the failed step and exits with 1 when a readiness step throws", async () => {
    const { proc, exited, log } = createProcess(TEST_MODE_LINES);

    await runHub(
      {
        version: "1",
        build: "hub",
        features: [],
        configure: (hub) => {
          hub.addReadinessStep("database", () => Promise.reject(new Error("the app role is a superuser")));
        },
      },
      proc,
    );

    await expect(exited).resolves.toBe(1);
    expect(log.lines()).toContainEqual(
      expect.objectContaining({
        msg: "The hub could not start",
        err: expect.objectContaining({
          type: "ReadinessError",
          step: "database",
          message: expect.stringContaining("the app role is a superuser") as unknown,
        }) as unknown,
      }),
    );
  });

  it("exits with 0 and logs no start failure when SIGTERM arrives while a step waits", async () => {
    const { proc, signal, exited, log } = createProcess(TEST_MODE_LINES);
    const running = runHub(
      {
        version: "1",
        build: "hub",
        features: [],
        configure: (hub) => {
          hub.addReadinessStep("database", (stepSignal) => {
            return new Promise<void>((_resolve, reject) => {
              stepSignal.addEventListener("abort", () => {
                reject(new Error("aborted"));
              });
            });
          });
        },
      },
      proc,
    );

    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => setImmediate(resolve));
    signal("SIGTERM");

    await expect(exited).resolves.toBe(0);
    await running;
    expect(log.lines().map((line) => line.msg)).not.toContain("The hub could not start");
  });
  it("logs the error and exits with 1 when the stop itself fails", async () => {
    const { proc, signal, exited, log } = createProcess(TEST_MODE_LINES);
    await runHub(
      {
        version: "1",
        build: "hub",
        features: [],
        configure: (hub) => {
          // The hub is the boundary of runHub: a stop that breaks stands for a bug in any part of it
          vi.spyOn(hub, "stop").mockRejectedValue(new Error("close failed"));
        },
      },
      proc,
    );

    signal("SIGTERM");

    await expect(exited).resolves.toBe(1);
    expect(log.lines()).toContainEqual(expect.objectContaining({ msg: "The hub could not stop", level: "error" }));
  });

  it("rejects without exiting when configure throws, since that is a bug of the app", async () => {
    const { proc, exits } = createProcess(TEST_MODE_LINES);
    const bug = new Error("feature list is broken");

    await expect(
      runHub(
        {
          version: "1",
          build: "hub",
          features: [],
          configure: () => {
            throw bug;
          },
        },
        proc,
      ),
    ).rejects.toBe(bug);
    expect(exits).toEqual([]);
  });
  it("exits with 1 at 30 s when the stop never ends", async () => {
    const { proc, signal, exits } = createProcess(TEST_MODE_LINES);
    await runHub(
      {
        version: "1",
        build: "hub",
        features: [],
        configure: (hub) => {
          // A stop that hangs anywhere, such as in a plugin's close, stands for any part of the hub
          vi.spyOn(hub, "stop").mockReturnValue(new Promise(() => undefined));
        },
      },
      proc,
    );

    signal("SIGTERM");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(exits).toEqual([1]);
  });
});
