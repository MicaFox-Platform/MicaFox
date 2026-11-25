import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTORS, openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";
import type { HubEvent } from "../../../events/index.js";

let tenancy: TenancyApp;
let environmentId: string;
let keysUrl: string;
let published: HubEvent[];

beforeEach(async () => {
  tenancy = await openTenancyApp();
  // A key's creator is a user of the hub; the tenancy app's actors are only ids
  await tenancy.test.db.system("test: add the user", async (trx) => {
    await sql`insert into users (id, email, name, password_hash)
      values (${ACTORS.adminA.userId}, 'admin@example.com', 'admin', 'x')`.execute(trx);
  });
  const project = await tenancy.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });
  const environments = await tenancy.get("ownerA", `/api/v1/projects/${String(project.body.id)}/environments`);
  environmentId = String((environments.body.items as Array<{ id: string }>)[0]?.id);
  keysUrl = `/api/v1/environments/${environmentId}/keys`;
  published = [];
  tenancy.events.bus.subscribe((event) => published.push(event));
});

afterEach(async () => {
  await tenancy.close();
});

describe("events of keys", () => {
  it("publishes key.created with the key's id and no token or prefix", async () => {
    const reply = await tenancy.post("adminA", keysUrl, { name: "ci" });

    expect(published).toEqual([
      {
        type: "key.created",
        orgId: ORG_A,
        environmentId,
        actor: { userId: ACTORS.adminA.userId },
        data: { keyId: reply.body.id, environmentId },
      },
    ]);
    expect(JSON.stringify(published)).not.toContain(String(reply.body.token));
  });

  it("publishes nothing for a sixth key, which is refused", async () => {
    for (let index = 0; index < 5; index += 1) {
      await tenancy.post("adminA", keysUrl, { name: `key ${String(index)}` });
    }
    published.length = 0;

    const reply = await tenancy.post("adminA", keysUrl, { name: "one too many" });

    expect([reply.status, published]).toEqual([409, []]);
  });

  it("publishes key.revoked once, and nothing for a key that is revoked already", async () => {
    const created = await tenancy.post("adminA", keysUrl, { name: "ci" });
    const keyId = String(created.body.id);
    published.length = 0;

    const first = await tenancy.delete("adminA", `/api/v1/keys/${keyId}`);
    const second = await tenancy.delete("adminA", `/api/v1/keys/${keyId}`);

    expect([first.status, second.status, published]).toEqual([
      204,
      404,
      [
        {
          type: "key.revoked",
          orgId: ORG_A,
          environmentId,
          actor: { userId: ACTORS.adminA.userId },
          data: { keyId, environmentId },
        },
      ],
    ]);
  });

  it("publishes nothing when a member tries to revoke", async () => {
    const created = await tenancy.post("adminA", keysUrl, { name: "ci" });
    published.length = 0;

    await tenancy.delete("memberA", `/api/v1/keys/${String(created.body.id)}`);

    expect(published).toEqual([]);
  });
});
