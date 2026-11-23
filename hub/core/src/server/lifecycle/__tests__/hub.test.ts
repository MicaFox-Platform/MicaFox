import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { envOf, TEST_MODE_LINES } from "../../../../test/server/env.js";
import { get } from "../../../../test/server/http.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import { ConfigError } from "../../config/index.js";
import { createHub, HubStateError, ReadinessError } from "../index.js";
import type { Hub } from "../index.js";

const hubs: Hub[] = [];

const create = (lines: readonly string[] = TEST_MODE_LINES): { hub: Hub; log: ReturnType<typeof captureLog> } => {
  const log = captureLog();
  const hub = createHub({
    env: envOf(lines),
    version: "1.2.3",
    build: "basic-hub",
    features: ["debugger"],
    logStream: log.stream,
  });
  hubs.push(hub);
  return { hub, log };
};

interface ControlledStep {
  run: () => Promise<void>;
  /** Settles once the hub runs the step, after the database step before it. */
  reached: Promise<void>;
  finish: () => void;
  fail: (error: Error) => void;
}

// A step the test finishes itself, so "not ready yet" can be observed
const controlledStep = (): ControlledStep => {
  let finish = (): void => undefined;
  let fail: (error: Error) => void = () => undefined;
  let markReached = (): void => undefined;
  const pending = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  return {
    run: async () => {
      markReached();
      await pending;
    },
    reached,
    finish: () => {
      finish();
    },
    fail: (error) => {
      fail(error);
    },
  };
};

afterEach(async () => {
  await Promise.all(hubs.splice(0).map(async (hub) => await hub.stop()));
});

describe("createHub", () => {
  it("throws every settings problem at once, before it listens", () => {
    expect(() =>
      createHub({ env: {}, version: "1", build: "hub", features: [], logStream: captureLog().stream }),
    ).toThrow(ConfigError);
  });

  it("answers /healthz at once and 503 not-ready everywhere else until the steps pass", async () => {
    const { hub } = create();
    const step = controlledStep();
    hub.addReadinessStep("migrations", step.run);

    const running = await hub.start();

    await expect(get(running.url, "/healthz")).resolves.toMatchObject({ status: 200, body: '{"status":"ok"}' });
    for (const path of ["/readyz", "/api/v1/anything", "/"]) {
      await expect(get(running.url, path)).resolves.toMatchObject({
        status: 503,
        contentType: "application/problem+json; charset=utf-8",
        body: expect.stringMatching(
          /^\{"type":"urn:micafox:problem:not-ready","title":"The hub is not ready","status":503,"requestId":"[\da-f-]{36}"\}$/,
        ) as unknown,
      });
    }
    step.finish();
    await running.ready;
    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 200, body: '{"status":"ready"}' });
    await expect(get(running.url, "/api/v1/anything")).resolves.toMatchObject({ status: 404 });
  });

  it("answers the 503 gate with the request id and the security headers", async () => {
    const { hub } = create();
    hub.addReadinessStep("migrations", controlledStep().run);
    const running = await hub.start();

    const reply = await get(running.url, "/api/v1/anything");

    expect(reply.headers).toMatchObject({
      "content-security-policy": expect.stringContaining("default-src 'self'") as unknown,
      "x-content-type-options": "nosniff",
    });
    expect(JSON.parse(reply.body)).toMatchObject({ requestId: reply.headers["x-request-id"] });
  });

  it("sends HSTS when the public URL is HTTPS", async () => {
    // The public URL names the proxy, not the bound port, so the test picks a free port itself
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const { hub } = create([
      "MICAFOX_TEST_MODE=true",
      "MICAFOX_DATABASE_URL=pglite:memory",
      "MICAFOX_HOST=127.0.0.1",
      `MICAFOX_PORT=${String(port)}`,
      "MICAFOX_PUBLIC_URL=https://hub.example.com",
    ]);
    await hub.start();

    const reply = await get(`http://127.0.0.1:${String(port)}`, "/healthz");

    expect(reply.headers["strict-transport-security"]).toBe("max-age=31536000");
  });

  it("stays not ready until every step has passed, in the order added", async () => {
    const { hub } = create();
    const order: string[] = [];
    const second = controlledStep();
    hub.addReadinessStep("first", async () => {
      order.push("first");
      await Promise.resolve();
    });
    hub.addReadinessStep("second", async () => {
      order.push("second");
      await second.run();
    });

    const running = await hub.start();
    await second.reached;

    expect(order).toEqual(["first", "second"]);
    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 503 });
    second.finish();
    await running.ready;
    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 200 });
  });

  it("turns ready once the database answers when no part adds a step", async () => {
    const { hub } = create();

    const running = await hub.start();
    await running.ready;

    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 200 });
  });

  it("logs hub.started once it is ready, with version, build, features and settings without secrets", async () => {
    const { hub, log } = create([...TEST_MODE_LINES, "MICAFOX_SETUP_TOKEN=setup-secret", "MICAFOX_LOG_LEVEL=debug"]);
    const step = controlledStep();
    hub.addReadinessStep("migrations", step.run);

    const running = await hub.start();
    expect(log.lines().filter((line) => line.msg === "hub.started")).toEqual([]);
    step.finish();
    await running.ready;

    const started = log.lines().filter((line) => line.msg === "hub.started");
    expect(started).toEqual([
      expect.objectContaining({
        level: "info",
        version: "1.2.3",
        build: "basic-hub",
        features: ["debugger"],
        settings: expect.objectContaining({
          publicUrl: running.url,
          setupToken: "[redacted]",
          databaseUrl: "pglite:memory",
        }) as unknown,
      }),
    ]);
    expect(log.text()).not.toContain("setup-secret");
  });

  it("takes the public URL in test mode from the port it bound", async () => {
    const { hub } = create();

    const running = await hub.start();

    expect(running.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(running.url).not.toBe("http://localhost:0");
  });

  it("rejects ready with the step's name when a step fails, and stays not ready", async () => {
    const { hub } = create();
    const step = controlledStep();
    hub.addReadinessStep("migrations", step.run);
    const running = await hub.start();
    await step.reached;
    const failure = new Error("the database holds an unknown migration");

    step.fail(failure);

    await expect(running.ready).rejects.toMatchObject({
      constructor: ReadinessError,
      step: "migrations",
      cause: failure,
    });
    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 503 });
  });

  it("does not raise an unhandled rejection when nobody awaits ready", async () => {
    const { hub } = create();
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    const step = controlledStep();
    hub.addReadinessStep("migrations", step.run);

    await hub.start();
    await step.reached;
    step.fail(new Error("down"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", record);

    expect(unhandled).toEqual([]);
  });

  it("refuses a readiness step once it has started, while its steps still run", async () => {
    const { hub } = create();
    await hub.start();

    expect(() => {
      hub.addReadinessStep("late", () => Promise.resolve());
    }).toThrow(HubStateError);
  });

  it("refuses a readiness step once it is ready", async () => {
    const { hub } = create();
    const running = await hub.start();
    await running.ready;

    expect(() => {
      hub.addReadinessStep("late", () => Promise.resolve());
    }).toThrow(HubStateError);
  });

  it("rejects start when the port is taken", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as net.AddressInfo;
    const { hub } = create([
      "MICAFOX_TEST_MODE=true",
      "MICAFOX_DATABASE_URL=pglite:memory",
      "MICAFOX_HOST=127.0.0.1",
      `MICAFOX_PORT=${String(port)}`,
    ]);

    await expect(hub.start()).rejects.toMatchObject({ code: "EADDRINUSE" });

    await new Promise((resolve) => taken.close(resolve));
  });

  it("turns /readyz to 503 as soon as the stop begins, while a hook still holds it", async () => {
    const { hub } = create();
    const hold = controlledStep();
    hub.addStopHook("flush", hold.run, { phase: "before-drain" });
    const running = await hub.start();
    await running.ready;
    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 200 });

    const stopping = hub.stop();

    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 503 });
    await expect(get(running.url, "/healthz")).resolves.toMatchObject({ status: 200 });
    hold.finish();
    await expect(stopping).resolves.toEqual({ clean: true });
  });

  it("returns the first result when stopped twice", async () => {
    const { hub } = create();
    await hub.start();

    const [first, second] = await Promise.all([hub.stop(), hub.stop()]);

    expect(first).toBe(second);
  });

  it("aborts a readiness step that is waiting when the hub stops", async () => {
    const { hub } = create();
    const seen: AbortSignal[] = [];
    const step = controlledStep();
    hub.addReadinessStep("migrations", async (signal) => {
      seen.push(signal);
      signal.addEventListener("abort", () => {
        step.fail(new Error("aborted"));
      });
      await step.run();
    });
    const running = await hub.start();
    await step.reached;

    await hub.stop();

    expect(seen[0]?.aborted).toBe(true);
    await expect(running.ready).rejects.toThrow("aborted");
  });

  it("answers /healthz with a query string before it is ready", async () => {
    const { hub } = create();
    hub.addReadinessStep("migrations", controlledStep().run);

    const running = await hub.start();

    await expect(get(running.url, "/healthz?probe=1")).resolves.toMatchObject({ status: 200 });
  });

  it("stops cleanly when it never started", async () => {
    const { hub } = create();

    await expect(hub.stop()).resolves.toEqual({ clean: true });
  });

  it("refuses a stop hook once the stop has begun", async () => {
    const { hub } = create();
    await hub.start();

    const stopping = hub.stop();

    expect(() => {
      hub.addStopHook("late", () => Promise.resolve());
    }).toThrow(HubStateError);
    await stopping;
  });
  it("collapses repeated warnings of its parts and logs their count when it stops", async () => {
    const { hub, log } = create();
    await hub.start();

    hub.warnCollapsed("sdk.key-rejected", { keyPrefix: "mfx_pk_ab" }, "A project key was rejected");
    hub.warnCollapsed("sdk.key-rejected", { keyPrefix: "mfx_pk_ab" }, "A project key was rejected");
    hub.warnCollapsed("sdk.key-rejected", { keyPrefix: "mfx_pk_ab" }, "A project key was rejected");
    await hub.stop();

    expect(log.lines().filter((line) => line.key === "sdk.key-rejected")).toEqual([
      expect.not.objectContaining({ count: expect.anything() as unknown }),
      expect.objectContaining({ count: 2, level: "warn" }),
    ]);
  });
});
