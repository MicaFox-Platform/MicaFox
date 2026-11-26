import { sql } from "kysely";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { addProjectKey } from "../../../../test/access/project-key.js";
import { ORG_A } from "../../../../test/db/test-database.js";
import { emptyFeature, protocolModule } from "../../../../test/feature/fixtures.js";
import { connectSdk, helloOf, openSdk } from "../../../../test/sdk-endpoint/sdk-client.js";
import { envOf, TEST_MODE_LINES } from "../../../../test/server/env.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import type { LogCapture } from "../../../../test/server/log-capture.js";
import type { Actor } from "../../access/index.js";
import { createHub } from "../index.js";
import type { Hub } from "../index.js";

const TOKEN = `mfx_pk_${"k".repeat(43)}`;
const ADMIN: Actor = { userId: "a0000000-0000-4000-8000-000000000002", memberships: [{ orgId: ORG_A, role: "admin" }] };

const hubs: Hub[] = [];

afterEach(async () => {
  await Promise.all(hubs.splice(0).map(async (hub) => await hub.stop()));
});

interface Setup {
  hub: Hub;
  /** Ends the readiness step that holds the hub. */
  release: () => void;
  keyId: Promise<string>;
  log: LogCapture;
}

// A hub with organization A and its key of TOKEN, held before ready until `release`, every request made by A's admin
const createHeldHub = (): Setup => {
  const log = captureLog();
  const hub = createHub({
    env: envOf(TEST_MODE_LINES),
    version: "1.2.3",
    build: "basic-hub",
    features: [emptyFeature("debugger", { protocol: protocolModule("debugger") })],
    logStream: log.stream,
    actorResolver: async () => await Promise.resolve(ADMIN),
  });
  hubs.push(hub);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveKey: (keyId: string) => void = () => undefined;
  const keyId = new Promise<string>((resolve) => {
    resolveKey = resolve;
  });
  hub.addReadinessStep("organization and key", async () => {
    await hub.db.system("test: add the organization", async (trx) => {
      await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme')`.execute(trx);
    });
    resolveKey(await addProjectKey(hub.db, { orgId: ORG_A, token: TOKEN }));
    await held;
  });
  return { hub, release, keyId, log };
};

const startReady = async (): Promise<{ hub: Hub; url: string; keyId: string; log: LogCapture }> => {
  const { hub, release, keyId, log } = createHeldHub();
  release();
  const running = await hub.start();
  await running.ready;
  return { hub, url: running.url, keyId: await keyId, log };
};

// The environment the key of `keyId` leads to
const environmentOf = async (hub: Hub, keyId: string): Promise<string> =>
  await hub.db.system("test: find the environment of a key", async (trx) => {
    const { rows } = await sql<{
      id: string;
    }>`select environment_id as id from credentials where id = ${keyId}`.execute(trx);
    return rows[0]?.id ?? "";
  });

interface Listed {
  id: string;
  online: boolean;
  service?: string;
}

const listInstances = async (url: string, environmentId: string): Promise<Listed[]> => {
  const response = await fetch(`${url}/api/v1/environments/${environmentId}/instances`);
  return ((await response.json()) as { items: Listed[] }).items;
};

// Sends a raw upgrade request to `path` and resolves with what the hub wrote once it closed the socket
const upgradeRaw = async (url: string, path: string): Promise<string> => {
  const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
  let written = "";
  socket.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: hub\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await new Promise<void>((resolve) =>
    socket.once("close", () => {
      resolve();
    }),
  );
  return written;
};

describe("the SDK endpoint in the hub", () => {
  it("welcomes an SDK with a key stored in the database", async () => {
    const { url } = await startReady();
    const client = await openSdk(url, TOKEN);

    expect(await client.hello()).toEqual({ version: 1, type: "welcome", modules: ["debugger"] });
  });

  it("answers 503 while the hub is not ready", async () => {
    const { hub, release } = createHeldHub();
    const { url } = await hub.start();

    const answer = await connectSdk(url, { token: TOKEN });
    release();

    expect(answer).toMatchObject({ status: 503, body: { type: "urn:micafox:problem:not-ready" } });
  });

  it("closes the sessions of a key revoked through the API with 1008", async () => {
    const { url, keyId } = await startReady();
    const client = await openSdk(url, TOKEN);
    await client.hello();

    await fetch(`${url}/api/v1/keys/${keyId}`, { method: "DELETE" });

    expect([await client.closed, await connectSdk(url, { token: TOKEN })]).toMatchObject([
      { code: 1008 },
      { status: 403 },
    ]);
  });

  it("closes every session with 1001 when the hub stops", async () => {
    const { hub, url } = await startReady();
    const client = await openSdk(url, TOKEN);
    await client.hello();

    const [closed, stopped] = await Promise.all([client.closed, hub.stop()]);

    expect([closed, stopped]).toEqual([{ code: 1001 }, { clean: true }]);
  });

  it("lists a connected SDK as an online instance, offline once it closes, and cuts what is too long", async () => {
    const { hub, url, keyId } = await startReady();
    const environmentId = await environmentOf(hub, keyId);
    const client = await openSdk(url, TOKEN);

    await client.hello(helloOf({ instanceId: "instance-1", service: "s".repeat(300) }));
    await expect
      .poll(async () => await listInstances(url, environmentId))
      .toMatchObject([{ id: "instance-1", online: true, service: "s".repeat(128) }]);
    client.socket.close();
    await client.closed;

    await expect
      .poll(async () => (await listInstances(url, environmentId)).map((item) => item.online))
      .toEqual([false]);
  });

  it("records no failed instance write when it stops with an SDK connected", async () => {
    const { hub, url, keyId, log } = await startReady();
    const environmentId = await environmentOf(hub, keyId);
    const client = await openSdk(url, TOKEN);
    await client.hello();
    await expect.poll(async () => (await listInstances(url, environmentId)).length).toBe(1);

    await hub.stop();

    expect(log.lines().filter((line) => String(line.msg).startsWith("instances."))).toEqual([]);
  });

  it("answers an upgrade to another route over HTTP and closes its socket", async () => {
    const { url } = await startReady();

    expect((await upgradeRaw(url, "/healthz")).split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
  });
});
