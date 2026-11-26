import { afterEach, describe, expect, it } from "vitest";

import { openEndpointApp, ORG_A, tokenOf } from "../../../../test/sdk-endpoint/endpoint-app.js";
import type { EndpointApp } from "../../../../test/sdk-endpoint/endpoint-app.js";
import { helloOf, openSdk } from "../../../../test/sdk-endpoint/sdk-client.js";

const TOKEN = tokenOf("a");
const apps: EndpointApp[] = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

const open = async (): Promise<EndpointApp> => {
  const app = await openEndpointApp();
  apps.push(app);
  return app;
};

describe("recording the instance of a session", () => {
  it("hands the instance its key, hello and agreed modules once welcome is sent", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    const hello = helloOf({ modules: ["debugger", "unknown"], instanceId: "instance-1" });
    await client.hello(hello);

    await expect.poll(() => app.instances.tracked.length).toBe(1);
    const [tracked] = app.instances.tracked;
    expect([tracked?.key.orgId, tracked?.hello, tracked?.modules]).toEqual([ORG_A, hello, ["debugger"]]);
  });

  it("gives the instances the promise of the session's close", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);
    await client.hello();
    await expect.poll(() => app.instances.tracked.length).toBe(1);
    let isClosed = false;
    void app.instances.tracked[0]?.closed.then(() => {
      isClosed = true;
    });

    client.socket.close();
    await client.closed;

    await expect.poll(() => isClosed).toBe(true);
  });

  it("records no instance for a connection that never sends a valid hello", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    client.sendRaw("not json");
    await client.closed;

    expect(app.instances.tracked).toEqual([]);
  });

  it("counts what was cut or repaired in the hello and warns once, with the session staying open", async () => {
    const app = await open();
    app.instances.result = { cut: 2, replaced: 3 };
    const client = await openSdk(app.url, TOKEN);

    await client.hello();

    await expect
      .poll(() => app.endpoint.counts())
      .toEqual([
        { name: "sanitized", count: 3 },
        { name: "cut", count: 2 },
      ]);
    expect(app.log.lines().filter((line) => line.msg === "sdk.hello-cut")).toHaveLength(1);
    expect(client.socket.readyState).toBe(1);
  });

  it("counts and warns of nothing when the hello fits", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    await client.hello();
    await expect.poll(() => app.instances.tracked.length).toBe(1);

    expect(app.endpoint.counts()).toEqual([]);
    expect(app.log.lines().some((line) => line.msg === "sdk.hello-cut")).toBe(false);
  });

  it("logs an instance that cannot be tracked and keeps the session open", async () => {
    const app = await open();
    app.instances.failure = new Error("broken");
    const client = await openSdk(app.url, TOKEN);

    await client.hello();

    await expect.poll(() => app.log.lines().some((line) => line.msg === "sdk.instance-track-failed")).toBe(true);
    expect(client.socket.readyState).toBe(1);
  });

  it("settles its close of every session only once the sessions closed and the instances settled", async () => {
    const app = await open();
    let release = (): void => undefined;
    app.instances.idleHold = new Promise((resolve) => {
      release = resolve;
    });
    const client = await openSdk(app.url, TOKEN);
    await client.hello();
    let isDone = false;

    const closing = app.endpoint.closeAll().then(() => {
      isDone = true;
    });
    await client.closed;
    await expect.poll(() => app.instances.calls.idle).toBe(1);
    const doneBeforeRelease = isDone;
    release();
    await closing;

    expect([doneBeforeRelease, isDone]).toEqual([false, true]);
  });
});
