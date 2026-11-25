import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { keyOf, openEndpointApp, ORG_A, ORG_B, tokenOf } from "../../../../test/sdk-endpoint/endpoint-app.js";
import type { EndpointApp } from "../../../../test/sdk-endpoint/endpoint-app.js";
import { connectSdk, helloOf, openSdk } from "../../../../test/sdk-endpoint/sdk-client.js";
import type { SdkClient } from "../../../../test/sdk-endpoint/sdk-client.js";

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

// A connection that got its welcome
const connected = async (app: EndpointApp, token = TOKEN, instanceId?: string): Promise<SdkClient> => {
  const client = await openSdk(app.url, token);
  await client.hello(helloOf(instanceId === undefined ? {} : { instanceId }));
  return client;
};

// A close frame the hub sent arrives before the answer to a later ping, so a pong proves the session is still open
const isStillOpen = async (client: SdkClient): Promise<boolean> => {
  const pong = once(client.socket, "pong");
  client.socket.ping();
  await Promise.race([pong, client.closed]);
  return client.socket.readyState === client.socket.OPEN;
};

describe("open sessions", () => {
  it("closes the old session of an instance with 1001 when it connects again in the same environment", async () => {
    const app = await open();
    const old = await connected(app);

    await connected(app);

    expect(await old.closed).toEqual({ code: 1001 });
  });

  it("never lets an instanceId from another environment replace a session", async () => {
    const app = await open();
    app.keys.set(tokenOf("staging"), keyOf("staging", { environmentId: "staging" }));
    const production = await connected(app);

    await connected(app, tokenOf("staging"));

    expect(await isStillOpen(production)).toBe(true);
  });

  it("closes the sessions of a revoked key with 1008, and its reconnect gets 403", async () => {
    const app = await open();
    const client = await connected(app);

    await app.revoke(TOKEN);

    expect([await client.closed, await connectSdk(app.url, { token: TOKEN })]).toMatchObject([
      { code: 1008 },
      { status: 403 },
    ]);
  });

  it("closes the sessions of an organization with 1001 when its entitlements change, and no other", async () => {
    const app = await open();
    app.keys.set(tokenOf("b"), keyOf("b", { orgId: ORG_B, environmentId: "b-production" }));
    const ofA = await connected(app);
    const ofB = await connected(app, tokenOf("b"));

    app.bus.publish({ type: "entitlements.changed", orgId: ORG_A, actor: { userId: "system" }, data: {} });

    expect([await ofA.closed, await isStillOpen(ofB)]).toEqual([{ code: 1001 }, true]);
  });

  it("closes every session with 1001 on stop", async () => {
    const app = await open();
    const client = await connected(app);

    await app.endpoint.closeAll();

    expect(await client.closed).toEqual({ code: 1001 });
  });

  it("terminates a connection that sends nothing, not even a ping, for 45 s", async () => {
    const app = await open();
    const client = await connected(app);

    app.manual.advance(50_000);

    expect(await client.closed).toEqual({ code: 1006 });
  });
});
