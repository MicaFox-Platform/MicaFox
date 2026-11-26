import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openTestDatabase, ORG_A, ORG_B } from "../../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../../test/db/test-database.js";
import { CORE_MIGRATIONS, migrate } from "../../index.js";

const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

const migratedWithEnvironment = async (): Promise<{ test: TestDatabase; projectId: string; environmentId: string }> => {
  const test = await openTestDatabase({ migrated: true });
  opened.push(test);
  await migrate(
    test.db,
    { url: test.ownerUrl ?? test.url, packages: [CORE_MIGRATIONS], log: test.logger },
    new AbortController().signal,
  );
  await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme')`.execute(test.db.global);
  const ids = await test.db.forOrg(ORG_A, async (trx) => {
    const project = await sql<{
      id: string;
    }>`insert into projects (org_id, name) values (${ORG_A}, 'Billing') returning id`.execute(trx);
    const projectId = project.rows[0]?.id ?? "";
    const environment = await sql<{ id: string }>`
      insert into environments (org_id, project_id, name) values (${ORG_A}, ${projectId}, 'production') returning id
    `.execute(trx);
    return { projectId, environmentId: environment.rows[0]?.id ?? "" };
  });
  return { test, ...ids };
};

describe("the project keys migration", () => {
  it("refuses a project key that leads nowhere or has no name", async () => {
    const { test } = await migratedWithEnvironment();

    await expect(
      sql`insert into credentials (kind, token_hash, org_id) values ('project-key', 'h1', ${ORG_A})`.execute(
        test.db.global,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a key whose organization is not its environment's", async () => {
    const { test, projectId, environmentId } = await migratedWithEnvironment();
    await sql`insert into orgs (id, name) values (${ORG_B}, 'Globex')`.execute(test.db.global);

    await expect(
      sql`insert into credentials (kind, token_hash, display_prefix, name, org_id, project_id, environment_id)
        values ('project-key', 'h1', 'mfx_pk_abcde', 'ci', ${ORG_B}, ${projectId}, ${environmentId})`.execute(
        test.db.global,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("deletes a key with its environment", async () => {
    const { test, projectId, environmentId } = await migratedWithEnvironment();
    await sql`insert into credentials (kind, token_hash, display_prefix, name, org_id, project_id, environment_id)
      values ('project-key', 'h1', 'mfx_pk_abcde', 'ci', ${ORG_A}, ${projectId}, ${environmentId})`.execute(
      test.db.global,
    );

    await test.db.forOrg(ORG_A, async (trx) => {
      await sql`delete from environments where id = ${environmentId}`.execute(trx);
    });

    const left = await sql<{ count: string }>`select count(*) from credentials`.execute(test.db.global);
    expect(left.rows).toEqual([{ count: "0" }]);
  });
});
