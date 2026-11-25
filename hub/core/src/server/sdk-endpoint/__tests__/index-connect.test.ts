import { CLOSE_CODES } from "@micafox/protocol";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keyOf, openEndpointApp, tokenOf } from "../../../../test/sdk-endpoint/endpoint-app.js";
import type { EndpointApp } from "../../../../test/sdk-endpoint/endpoint-app.js";
import { connectSdk, helloOf, openSdk } from "../../../../test/sdk-endpoint/sdk-client.js";

const TOKEN = tokenOf("a");
const apps: EndpointApp[] = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

const open = async (
  settings: Parameters<typeof openEndpointApp>[0] = {},
  gate?: Parameters<typeof openEndpointApp>[1],
): Promise<EndpointApp> => {
  const app = await openEndpointApp(settings, gate);
  apps.push(app);
  return app;
};

describe("GET /sdk before the upgrade", () => {
  it("refuses a request without a bearer token with 401 and a problem", async () => {
    const app = await open();

    expect(await connectSdk(app.url)).toMatchObject({
      status: 401,
      contentType: "application/problem+json; charset=utf-8",
      body: { type: "urn:micafox:problem:unauthenticated", detail: "A project key is required as a bearer token" },
    });
  });

  it("refuses an unknown key with 403", async () => {
    const app = await open();

    expect(await connectSdk(app.url, { token: tokenOf("unknown") })).toMatchObject({
      status: 403,
      body: { type: "urn:micafox:problem:forbidden" },
    });
  });

  it("refuses a connection over MICAFOX_SDK_MAX_CONNECTIONS_PER_KEY with 429", async () => {
    const app = await open({ sdkMaxConnectionsPerKey: 1 });
    await openSdk(app.url, TOKEN);

    expect(await connectSdk(app.url, { token: TOKEN })).toMatchObject({
      status: 429,
      body: { type: "urn:micafox:problem:rate-limited" },
    });
  });

  it("refuses a connection over MICAFOX_SDK_MAX_CONNECTIONS with 429", async () => {
    const app = await open({ sdkMaxConnections: 1 });
    app.keys.set(tokenOf("b"), keyOf("b"));
    await openSdk(app.url, TOKEN);

    expect(await connectSdk(app.url, { token: tokenOf("b") })).toMatchObject({ status: 429 });
  });

  it("refuses the connection over the limit when lookups that ran at once all find their key", async () => {
    const app = await open({ sdkMaxConnections: 1 });
    app.keys.set(tokenOf("b"), keyOf("b"));
    let release = (): void => undefined;
    app.database.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = [connectSdk(app.url, { token: TOKEN }), connectSdk(app.url, { token: tokenOf("b") })];
    await vi.waitFor(() => {
      expect(app.database.lookups).toBe(2);
    });

    release();

    expect((await Promise.all(attempts)).map((result) => ("status" in result ? result.status : 101)).sort()).toEqual([
      101, 429,
    ]);
  });

  it("looks a key up once for connections that arrive together", async () => {
    const app = await open();
    let release = (): void => undefined;
    app.database.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts = [connectSdk(app.url, { token: TOKEN }), connectSdk(app.url, { token: TOKEN })];
    await vi.waitFor(() => {
      expect(app.database.lookups).toBeGreaterThan(0);
    });

    release();
    await Promise.all(attempts);

    expect(app.database.lookups).toBe(1);
  });

  it("counts a connection again once it has closed", async () => {
    const app = await open({ sdkMaxConnectionsPerKey: 1 });
    const first = await openSdk(app.url, TOKEN);
    first.socket.close();
    await first.closed;

    expect(await connectSdk(app.url, { token: TOKEN })).not.toHaveProperty("status");
  });

  it("answers 503 when the database is down and the key is not cached", async () => {
    const app = await open();
    app.database.isDown = true;

    expect(await connectSdk(app.url, { token: TOKEN })).toMatchObject({
      status: 503,
      body: { type: "urn:micafox:problem:not-ready" },
    });
  });

  it("lets a cached key connect while the database is down", async () => {
    const app = await open();
    (await openSdk(app.url, TOKEN)).socket.close();
    app.database.isDown = true;

    expect(await connectSdk(app.url, { token: TOKEN })).not.toHaveProperty("status");
  });

  it("answers a plain HTTP request to /sdk with 404", async () => {
    const app = await open();

    const response = await fetch(`${app.url}/sdk`, { headers: { authorization: `Bearer ${TOKEN}` } });

    expect([response.status, app.usedKeys]).toEqual([404, []]);
  });

  it("answers an upgrade to another path with 404", async () => {
    const app = await open();

    expect(await connectSdk(app.url, { token: TOKEN, path: "/nope" })).toMatchObject({ status: 404 });
  });
});

describe("the handshake", () => {
  it("answers hello with welcome and the modules a feature serves that the organization may use", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    const welcome = await client.hello(helloOf({ modules: ["debugger", "profiler", "logs"] }));

    expect(welcome).toEqual({ version: 1, type: "welcome", modules: ["debugger"] });
  });

  it("closes with protocolError when the first frame is not a hello", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    client.send({ version: 1, type: "batch", messages: [] });

    expect(await client.closed).toEqual({ code: CLOSE_CODES.protocolError });
  });

  it("closes with protocolError on an instanceId over 64 characters", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    client.send(helloOf({ instanceId: "i".repeat(65) }));

    expect(await client.closed).toEqual({ code: CLOSE_CODES.protocolError });
  });

  it("closes with incompatibleVersion on a version the hub has no types for", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    client.send({ ...helloOf(), version: 2 });

    expect(await client.closed).toEqual({ code: CLOSE_CODES.incompatibleVersion });
  });

  it("closes with protocolError when no hello comes within 10 s", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);

    app.manual.advance(10_000);

    expect(await client.closed).toEqual({ code: CLOSE_CODES.protocolError });
  });

  it("closes with 1011 when the entitlements cannot be read", async () => {
    const app = await open(
      {},
      {
        isEntitled: async () => await Promise.reject(new Error("source down")),
        isModuleEntitled: async () => await Promise.reject(new Error("source down")),
      },
    );
    const client = await openSdk(app.url, TOKEN);

    client.send(helloOf());

    expect(await client.closed).toEqual({ code: 1011 });
  });

  it("closes with 1011 when the hello is read but welcome is not ready within 10 s", async () => {
    let asked = (): void => undefined;
    const isAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const never = async (): Promise<boolean> =>
      await new Promise<boolean>(() => {
        asked();
      });
    const app = await open({}, { isEntitled: never, isModuleEntitled: never });
    const client = await openSdk(app.url, TOKEN);
    client.send(helloOf());
    await isAsked;

    app.manual.advance(10_000);

    expect(await client.closed).toEqual({ code: 1011 });
  });

  it("closes with 1009 on a frame over MICAFOX_SDK_MAX_FRAME_BYTES", async () => {
    const app = await open({ sdkMaxFrameBytes: 1024 });
    const client = await openSdk(app.url, TOKEN);

    client.send(helloOf({ hostname: "h".repeat(2048) }));

    expect(await client.closed).toEqual({ code: 1009 });
  });

  it("answers pings", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);
    await client.hello();
    const pong = once(client.socket, "pong");

    client.socket.ping("are you there");

    expect(String((await pong)[0])).toBe("are you there");
  });

  it("notes the key's use on connect and on every ping", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);
    await client.hello();
    const pong = once(client.socket, "pong");

    client.socket.ping();
    await pong;

    expect(app.usedKeys).toEqual(["key-a", "key-a"]);
  });

  it("logs the connection with the key's prefix and never the key", async () => {
    const app = await open();
    const client = await openSdk(app.url, TOKEN);
    await client.hello();

    expect([
      app.log.lines().find((line) => line.msg === "sdk.connected")?.keyPrefix,
      app.log.text().includes(TOKEN),
    ]).toEqual([TOKEN.slice(0, 12), false]);
  });
});
