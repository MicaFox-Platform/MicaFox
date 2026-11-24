import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActorName, TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { openTenancyApp, ACTORS } from "../../../../../test/access/tenancy-app.js";
import { ORG_B } from "../../../../../test/db/test-database.js";

let tenancy: TenancyApp;
let keysUrlOfB: string;
let keyOfB: Record<string, unknown>;

beforeEach(async () => {
  tenancy = await openTenancyApp();
  await tenancy.test.db.system("test: add the owner of B", async (trx) => {
    await sql`insert into users (id, email, name, password_hash) values (${ACTORS.ownerB.userId}, 'b@example.com', 'b', 'x')`.execute(
      trx,
    );
  });
  const project = await tenancy.post("ownerB", `/api/v1/orgs/${ORG_B}/projects`, { name: "Secret" });
  const environments = await tenancy.get("ownerB", `/api/v1/projects/${String(project.body.id)}/environments`);
  keysUrlOfB = `/api/v1/environments/${String((environments.body.items as Array<{ id: string }>)[0]?.id)}/keys`;
  keyOfB = (await tenancy.post("ownerB", keysUrlOfB, { name: "prod" })).body;
});

afterEach(async () => {
  await tenancy.close();
});

describe("isolation of organizations on the key routes", () => {
  it.each(["ownerA", "adminA", "memberA", "nobody"] as const)(
    "answers 404 to %s on every route with B's ids",
    async (actor: ActorName) => {
      const statuses = [
        (await tenancy.get(actor, keysUrlOfB)).status,
        (await tenancy.post(actor, keysUrlOfB, { name: "mine" })).status,
        (await tenancy.delete(actor, `/api/v1/keys/${String(keyOfB.id)}`)).status,
      ];

      expect(statuses).toEqual([404, 404, 404]);
    },
  );

  it("leaves B's key active and its list unchanged after A's attempts", async () => {
    await tenancy.delete("ownerA", `/api/v1/keys/${String(keyOfB.id)}`);
    await tenancy.post("ownerA", keysUrlOfB, { name: "mine" });

    const list = await tenancy.get("ownerB", keysUrlOfB);
    const found = await tenancy.access.lookupKey(String(keyOfB.token));

    expect([(list.body.items as Array<{ name: string }>).map((key) => key.name), found?.keyId]).toEqual([
      ["prod"],
      keyOfB.id,
    ]);
  });

  it("applies the role of the organization that holds the key, for an actor of both", async () => {
    const reply = await tenancy.delete("both", `/api/v1/keys/${String(keyOfB.id)}`);

    expect(reply.status).toBe(204);
  });
});
