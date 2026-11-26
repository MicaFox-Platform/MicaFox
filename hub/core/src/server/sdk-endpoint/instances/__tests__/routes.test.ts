import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";
import { addOfflineInstances } from "../../../../../test/sdk-endpoint/instances-database.js";
import { helloOf } from "../../../../../test/sdk-endpoint/sdk-client.js";
import type { KeyScope } from "../../../access/index.js";

const DAY_MS = 24 * 60 * 60_000;

let tenancy: TenancyApp;
let scope: Pick<KeyScope, "orgId" | "projectId" | "environmentId">;
let closeSessions: Array<() => void>;

beforeEach(async () => {
  tenancy = await openTenancyApp();
  closeSessions = [];
  const project = await tenancy.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });
  const projectId = String(project.body.id);
  const environments = await tenancy.get("ownerA", `/api/v1/projects/${projectId}/environments`);
  const [environment] = environments.body.items as Array<{ id: string }>;
  scope = { orgId: ORG_A, projectId, environmentId: environment?.id ?? "" };
});

afterEach(async () => {
  for (const close of closeSessions) {
    close();
  }
  await tenancy.instances.idle();
  await tenancy.close();
});

const url = (query = ""): string => `/api/v1/environments/${scope.environmentId}/instances${query}`;

// An instance with a session that stays open until the test ends, or until `close` is called
const connect = async (hello = helloOf()): Promise<() => void> => {
  let close = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  closeSessions.push(close);
  await tenancy.instances.track({
    key: { ...scope, keyId: "key", prefix: "mfx_pk_abcd" },
    hello,
    modules: ["debugger"],
    closed,
  });
  return close;
};

const idsOf = (body: Record<string, unknown>): string[] =>
  (body.items as Array<{ id: string }>).map((instance) => instance.id);

describe("GET /api/v1/environments/{environmentId}/instances", () => {
  it("answers 401 without a user", async () => {
    expect((await tenancy.get(undefined, url())).status).toBe(401);
  });

  it("answers an instance with the fields of its hello and whether it is online", async () => {
    await connect(helloOf({ instanceId: "instance-1", commit: undefined }));

    const reply = await tenancy.get("memberA", url());

    expect(reply.status).toBe(200);
    expect(reply.body.items).toEqual([
      {
        id: "instance-1",
        online: true,
        service: "checkout",
        labels: { region: "eu" },
        hostname: "checkout-7d9f",
        pid: 1,
        sdk: { name: "@micafox/sdk", version: "0.1.0" },
        runtime: { name: "node", version: process.versions.node },
        modules: ["debugger"],
        protocolVersion: 1,
        keyPrefix: "mfx_pk_abcd",
        connectedAt: expect.any(String) as string,
        lastSeenAt: expect.any(String) as string,
      },
    ]);
    expect(reply.body.nextCursor).toBeUndefined();
  });

  it("answers the commit of the hello when it has one", async () => {
    await connect(helloOf({ commit: "abc123" }));

    const reply = await tenancy.get("memberA", url());

    expect((reply.body.items as Array<{ commit: string }>)[0]?.commit).toBe("abc123");
  });

  it("lists the instances that are online first, then by last seen, newest first", async () => {
    const future = new Date(Date.now() + DAY_MS);
    await addOfflineInstances(tenancy.test.db, scope, { count: 3, firstSeenAt: future, prefix: "off" });
    await connect(helloOf({ instanceId: "on" }));

    const reply = await tenancy.get("memberA", url());

    expect(idsOf(reply.body)).toEqual(["on", "off-0002", "off-0001", "off-0000"]);
  });

  it("turns an instance offline once its session closes", async () => {
    const close = await connect(helloOf({ instanceId: "instance-1" }));
    close();
    await tenancy.instances.idle();

    const reply = await tenancy.get("memberA", url());

    expect((reply.body.items as Array<{ online: boolean }>).map((instance) => instance.online)).toEqual([false]);
  });

  it("keeps only the online instances for ?online=true and only the offline ones for ?online=false", async () => {
    await addOfflineInstances(tenancy.test.db, scope, { count: 2, firstSeenAt: new Date(), prefix: "off" });
    await connect(helloOf({ instanceId: "on" }));

    const online = await tenancy.get("memberA", url("?online=true"));
    const offline = await tenancy.get("memberA", url("?online=false"));

    expect([idsOf(online.body), idsOf(offline.body)]).toEqual([["on"], ["off-0001", "off-0000"]]);
  });

  it("keeps only the instances of the service for ?service=", async () => {
    await connect(helloOf({ instanceId: "a", service: "checkout" }));
    await connect(helloOf({ instanceId: "b", service: "billing" }));
    await connect(helloOf({ instanceId: "c", service: undefined }));

    const reply = await tenancy.get("memberA", url("?service=billing"));

    expect(idsOf(reply.body)).toEqual(["b"]);
  });

  it("combines the filters", async () => {
    await connect(helloOf({ instanceId: "a", service: "checkout" }));
    await addOfflineInstances(tenancy.test.db, scope, { count: 1, firstSeenAt: new Date(), prefix: "off" });

    const reply = await tenancy.get("memberA", url("?online=false&service=checkout"));

    expect(idsOf(reply.body)).toEqual([]);
  });

  it("pages through the list in order without missing or repeating an instance", async () => {
    await addOfflineInstances(tenancy.test.db, scope, {
      count: 5,
      firstSeenAt: new Date(Date.now() + DAY_MS),
      prefix: "off",
    });
    await connect(helloOf({ instanceId: "on" }));
    const seen: string[] = [];

    let cursor: string | undefined;
    let pages = 0;
    do {
      const reply = await tenancy.get("memberA", url(`?limit=2${cursor === undefined ? "" : `&cursor=${cursor}`}`));
      seen.push(...idsOf(reply.body));
      cursor = reply.body.nextCursor as string | undefined;
      pages += 1;
    } while (cursor !== undefined);

    expect([seen, pages]).toEqual([["on", "off-0004", "off-0003", "off-0002", "off-0001", "off-0000"], 3]);
  });

  it("breaks a tie of last seen by the instanceId", async () => {
    const at = new Date(Date.now() + DAY_MS);
    await addOfflineInstances(tenancy.test.db, scope, { count: 1, firstSeenAt: at, prefix: "b" });
    await addOfflineInstances(tenancy.test.db, scope, { count: 1, firstSeenAt: at, prefix: "a" });

    const first = await tenancy.get("memberA", url("?limit=1"));
    const second = await tenancy.get("memberA", url(`?limit=1&cursor=${String(first.body.nextCursor)}`));

    expect([idsOf(first.body), idsOf(second.body), second.body.nextCursor]).toEqual([
      ["a-0000"],
      ["b-0000"],
      undefined,
    ]);
  });

  it("answers 400 validation for a cursor this hub did not make", async () => {
    const reply = await tenancy.get("memberA", url("?cursor=bm90LWEtY3Vyc29y"));

    expect(reply).toMatchObject({ status: 400, body: { type: "urn:micafox:problem:validation" } });
  });

  it.each(["?online=maybe", "?limit=0", `?service=${"x".repeat(129)}`, "?service=a%00b"])(
    "answers 400 validation for %s",
    async (query) => {
      expect((await tenancy.get("memberA", url(query))).status).toBe(400);
    },
  );

  it("answers 404 for an environment of another organization, one that does not exist and a non-member", async () => {
    await connect();

    const otherOrg = await tenancy.get("ownerB", url());
    const unknown = await tenancy.get("memberA", "/api/v1/environments/4d1e9c07-21b4-4f0a-8c3e-0a9f7e5d6b02/instances");
    const nobody = await tenancy.get("nobody", url());

    expect([otherOrg.status, unknown.status, nobody.status]).toEqual([404, 404, 404]);
  });

  it("answers 400 validation for an environment id that is not a UUID", async () => {
    const reply = await tenancy.get("memberA", "/api/v1/environments/production/instances");

    expect(reply.status).toBe(400);
  });
});
