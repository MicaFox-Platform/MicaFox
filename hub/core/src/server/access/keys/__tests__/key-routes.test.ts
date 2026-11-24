import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTORS, openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { ActorName, TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";
import { hashToken } from "../../tokens/index.js";

let tenancy: TenancyApp;
let projectId: string;
let environmentId: string;
let keysUrl: string;

// Opens the app with organization A's project and the users who act in it
const openKeysApp = async (publicUrl?: string): Promise<void> => {
  tenancy = await openTenancyApp(publicUrl === undefined ? {} : { publicUrl });
  // A key's creator is a user of the hub; the tenancy app's actors are only ids
  await tenancy.test.db.system("test: add the users", async (trx) => {
    for (const name of ["ownerA", "adminA", "memberA"] as const) {
      const { userId } = ACTORS[name];
      await sql`insert into users (id, email, name, password_hash) values (${userId}, ${`${name}@example.com`}, ${name}, 'x')`.execute(
        trx,
      );
    }
  });
  const project = await tenancy.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });
  projectId = String(project.body.id);
  const environments = await tenancy.get("ownerA", `/api/v1/projects/${projectId}/environments`);
  environmentId = String((environments.body.items as Array<{ id: string }>)[0]?.id);
  keysUrl = `/api/v1/environments/${environmentId}/keys`;
};

beforeEach(async () => {
  await openKeysApp();
});

afterEach(async () => {
  await tenancy.close();
});

const createKey = async (name = "ci", actor: ActorName = "adminA"): Promise<Record<string, unknown>> =>
  (await tenancy.post(actor, keysUrl, { name })).body;

const storedKeys = async (): Promise<Array<Record<string, unknown>>> =>
  (
    await tenancy.test.db.system(
      "test: read the stored keys",
      async (trx) =>
        await sql<Record<string, unknown>>`
          select token_hash as "tokenHash", display_prefix as "displayPrefix", name, created_by as "createdBy",
          environment_id as "environmentId", revoked_at as "revokedAt"
          from credentials where kind = 'project-key' order by created_at
        `.execute(trx),
    )
  ).rows;

describe("POST /api/v1/environments/{environmentId}/keys", () => {
  it("answers the token once, with the hub URL, and stores only its hash, prefix, name and creator", async () => {
    const reply = await tenancy.post("adminA", keysUrl, { name: "  CI deploy " });

    const token = String(reply.body.token);
    expect(reply).toMatchObject({
      status: 201,
      body: {
        name: "CI deploy",
        prefix: token.slice(0, 12),
        hubUrl: "wss://hub.example.com/sdk",
        createdBy: "a0000000-0000-4000-8000-000000000002",
        lastUsedAt: null,
      },
    });
    expect(token).toMatch(/^mfx_pk_[A-Za-z0-9_-]{43}$/);
    expect(await storedKeys()).toMatchObject([
      {
        tokenHash: hashToken(token),
        displayPrefix: token.slice(0, 12),
        name: "CI deploy",
        environmentId,
      },
    ]);
  });

  it("answers a ws: hub URL when the hub runs on plain HTTP", async () => {
    await tenancy.close();
    await openKeysApp("http://localhost:4000");

    const reply = await tenancy.post("adminA", keysUrl, { name: "dev" });

    expect(reply.body.hubUrl).toBe("ws://localhost:4000/sdk");
  });

  it("never stores or logs the token", async () => {
    const token = String((await createKey()).token);

    const stored = await tenancy.test.db.system(
      "test: read every credential",
      async (trx) =>
        await sql<{ row: string }>`select to_jsonb(credentials)::text as row from credentials`.execute(trx),
    );

    expect([JSON.stringify(stored.rows).includes(token), tenancy.log.text().includes(token)]).toEqual([false, false]);
  });

  it("answers 409 conflict for a sixth active key, and takes a new one once a key is revoked", async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => await createKey(`key ${String(index)}`)),
    );

    const sixth = await tenancy.post("adminA", keysUrl, { name: "sixth" });
    await tenancy.delete("adminA", `/api/v1/keys/${String(created[0]?.id)}`);
    const again = await tenancy.post("adminA", keysUrl, { name: "sixth" });

    expect([sixth.status, sixth.body.type, again.status]).toEqual([409, "urn:micafox:problem:conflict", 201]);
  });

  it("holds the limit when six keys are created at once", async () => {
    const replies = await Promise.all(
      Array.from(
        { length: 6 },
        async (_, index) => await tenancy.post("adminA", keysUrl, { name: `key ${String(index)}` }),
      ),
    );

    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 201, 201, 201, 201, 409]);
  });

  it("answers 400 validation for an empty name, without storing a key", async () => {
    const reply = await tenancy.post("adminA", keysUrl, { name: "   " });

    expect([reply.status, (await storedKeys()).length]).toEqual([400, 0]);
  });

  it("answers 403 forbidden to a member, 404 for an unknown environment and 401 without a login", async () => {
    const statuses = [
      (await tenancy.post("memberA", keysUrl, { name: "ci" })).status,
      (await tenancy.post("adminA", "/api/v1/environments/6f1c0f0e-6a3e-4e55-9d0c-6f1c1d2b8a99/keys", { name: "ci" }))
        .status,
      (await tenancy.post(undefined, keysUrl, { name: "ci" })).status,
    ];

    expect(statuses).toEqual([403, 404, 401]);
  });

  it("logs the creation as a security event with the prefix and not the token", async () => {
    const key = await createKey();

    const event = tenancy.log.lines().find((line) => line.event === "key.created");

    expect(event).toMatchObject({
      level: 30,
      userId: "a0000000-0000-4000-8000-000000000002",
      orgId: ORG_A,
      environmentId,
      keyId: key.id,
      keyPrefix: key.prefix,
    });
  });
});

describe("GET /api/v1/environments/{environmentId}/keys", () => {
  it("lists the active keys with their prefix and last use, and never a token", async () => {
    const first = await createKey("first");
    const revoked = await createKey("revoked");
    await createKey("last");
    await tenancy.delete("adminA", `/api/v1/keys/${String(revoked.id)}`);

    const reply = await tenancy.get("adminA", keysUrl);

    const items = reply.body.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.name)).toEqual(["first", "last"]);
    expect(items[0]).toEqual({
      id: first.id,
      name: "first",
      prefix: first.prefix,
      createdBy: "a0000000-0000-4000-8000-000000000002",
      createdAt: first.createdAt,
      lastUsedAt: null,
    });
  });

  it("shows the last use the SDK endpoint wrote", async () => {
    const key = await createKey();
    await tenancy.test.db.system("test: write the last use", async (trx) => {
      await sql`update credentials set last_used_at = '2026-11-01T10:00:00Z' where id = ${String(key.id)}`.execute(trx);
    });

    const reply = await tenancy.get("adminA", keysUrl);

    expect((reply.body.items as Array<Record<string, unknown>>)[0]?.lastUsedAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("shows no creator once the user who made the key is gone", async () => {
    await createKey();
    await tenancy.test.db.system("test: delete the creator", async (trx) => {
      await sql`delete from users where id = ${ACTORS.adminA.userId}`.execute(trx);
    });

    const reply = await tenancy.get("ownerA", keysUrl);

    expect((reply.body.items as Array<Record<string, unknown>>)[0]?.createdBy).toBeNull();
  });

  it("answers 403 forbidden to a member, even though they read the environment", async () => {
    await createKey();

    const reply = await tenancy.get("memberA", keysUrl);

    expect([reply.status, JSON.stringify(reply.body).includes("mfx_pk_")]).toEqual([403, false]);
  });
});

describe("DELETE /api/v1/keys/{keyId}", () => {
  it("revokes the key, runs the revoke hooks after it and logs the event", async () => {
    const key = await createKey();
    const revokedWhenHookRan: Array<{ keyId: string; listed: number }> = [];
    tenancy.access.onKeyRevoked(async (scope) => {
      const listed = (await tenancy.get("adminA", keysUrl)).body.items as unknown[];
      revokedWhenHookRan.push({ keyId: scope.keyId, listed: listed.length });
    });

    const reply = await tenancy.delete("adminA", `/api/v1/keys/${String(key.id)}`);

    expect(reply.status).toBe(204);
    expect(revokedWhenHookRan).toEqual([{ keyId: key.id, listed: 0 }]);
    expect(tenancy.log.lines().find((line) => line.event === "key.revoked")).toMatchObject({
      keyId: key.id,
      orgId: ORG_A,
      environmentId,
      keyPrefix: key.prefix,
    });
  });

  it("gives the hooks the key's organization, project and environment", async () => {
    const key = await createKey();
    const seen: unknown[] = [];
    tenancy.access.onKeyRevoked((scope) => {
      seen.push(scope);
    });

    await tenancy.delete("adminA", `/api/v1/keys/${String(key.id)}`);

    expect(seen).toEqual([{ keyId: key.id, prefix: key.prefix, orgId: ORG_A, projectId, environmentId }]);
  });

  it("answers 204 and still revokes when a hook fails, and runs the hooks after it", async () => {
    const key = await createKey();
    const ran: string[] = [];
    tenancy.access.onKeyRevoked(() => {
      throw new Error("the socket is gone");
    });
    tenancy.access.onKeyRevoked(() => {
      ran.push("second");
    });

    const reply = await tenancy.delete("adminA", `/api/v1/keys/${String(key.id)}`);

    expect([reply.status, ran, (await storedKeys())[0]?.revokedAt instanceof Date]).toEqual([204, ["second"], true]);
    expect(tenancy.log.lines().find((line) => line.msg === "A key revoke hook failed")).toMatchObject({ level: 50 });
  });

  it("answers 404 for a key that is revoked already, so its hooks run once", async () => {
    const key = await createKey();
    let runs = 0;
    tenancy.access.onKeyRevoked(() => {
      runs += 1;
    });

    const statuses = [
      (await tenancy.delete("adminA", `/api/v1/keys/${String(key.id)}`)).status,
      (await tenancy.delete("adminA", `/api/v1/keys/${String(key.id)}`)).status,
    ];

    expect([statuses, runs]).toEqual([[204, 404], 1]);
  });

  it("answers 403 forbidden to a member and leaves the key active", async () => {
    const key = await createKey();
    let runs = 0;
    tenancy.access.onKeyRevoked(() => {
      runs += 1;
    });

    const reply = await tenancy.delete("memberA", `/api/v1/keys/${String(key.id)}`);

    expect([reply.status, runs, (await storedKeys())[0]?.revokedAt]).toEqual([403, 0, null]);
  });

  it("answers 404 for an unknown key and 401 without a login", async () => {
    const key = await createKey();

    const statuses = [
      (await tenancy.delete("adminA", "/api/v1/keys/6f1c0f0e-6a3e-4e55-9d0c-6f1c1d2b8a99")).status,
      (await tenancy.delete(undefined, `/api/v1/keys/${String(key.id)}`)).status,
    ];

    expect(statuses).toEqual([404, 401]);
  });
});

describe("lookupKey", () => {
  it("finds an active key by its token and says where it leads", async () => {
    const key = await createKey();

    const found = await tenancy.access.lookupKey(String(key.token));

    expect(found).toEqual({
      keyId: key.id,
      orgId: ORG_A,
      projectId,
      environmentId,
      prefix: key.prefix,
    });
  });

  it("gives nothing for a revoked key, an unknown token or the stored hash itself", async () => {
    const key = await createKey();
    await tenancy.delete("adminA", `/api/v1/keys/${String(key.id)}`);

    const found = await Promise.all([
      tenancy.access.lookupKey(String(key.token)),
      tenancy.access.lookupKey("mfx_pk_unknown"),
      tenancy.access.lookupKey(hashToken(String(key.token))),
    ]);

    expect(found).toEqual([undefined, undefined, undefined]);
  });

  it("gives nothing for a token of another kind, which holds no environment", async () => {
    await tenancy.test.db.system("test: add a personal token", async (trx) => {
      await sql`insert into credentials (kind, token_hash, org_id) values ('personal-token', ${hashToken("mfx_pat_x")}, ${ORG_A})`.execute(
        trx,
      );
    });

    expect(await tenancy.access.lookupKey("mfx_pat_x")).toBeUndefined();
  });
});
