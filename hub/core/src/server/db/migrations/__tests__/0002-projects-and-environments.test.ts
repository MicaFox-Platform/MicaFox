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

const migrated = async (): Promise<TestDatabase> => {
  const test = await openTestDatabase({ migrated: true });
  opened.push(test);
  await migrate(
    test.db,
    { url: test.ownerUrl ?? test.url, packages: [CORE_MIGRATIONS], log: test.logger },
    new AbortController().signal,
  );
  await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme'), (${ORG_B}, 'Globex')`.execute(test.db.global);
  return test;
};

const addProject = async (test: TestDatabase, orgId: string, name: string): Promise<string> =>
  await test.db.forOrg(orgId, async (trx) => {
    const { rows } = await sql<{ id: string }>`
      insert into projects (org_id, name) values (${orgId}, ${name}) returning id
    `.execute(trx);
    return rows[0]?.id ?? "";
  });

describe("the projects and environments migration", () => {
  it("puts projects and environments under forced row-level security", async () => {
    const test = await migrated();

    const { rows } = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('projects', 'environments') order by relname
    `.execute(test.db.global);

    expect(rows).toEqual([
      { relname: "environments", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "projects", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("refuses a project name taken in the organization, whatever its case", async () => {
    const test = await migrated();
    await addProject(test, ORG_A, "Billing");

    await expect(addProject(test, ORG_A, "BILLING")).rejects.toMatchObject({ code: "23505" });
  });

  it("lets two organizations use the same project name", async () => {
    const test = await migrated();
    await addProject(test, ORG_A, "Billing");

    await expect(addProject(test, ORG_B, "Billing")).resolves.toEqual(expect.any(String));
  });

  it("refuses an environment name taken in the project, whatever its case", async () => {
    const test = await migrated();
    const projectId = await addProject(test, ORG_A, "Billing");
    const addEnvironment = async (name: string): Promise<void> => {
      await test.db.forOrg(ORG_A, async (trx) => {
        await sql`insert into environments (org_id, project_id, name) values (${ORG_A}, ${projectId}, ${name})`.execute(
          trx,
        );
      });
    };
    await addEnvironment("production");

    await expect(addEnvironment("Production")).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses an environment whose organization is not its project's", async () => {
    const test = await migrated();
    const projectId = await addProject(test, ORG_A, "Billing");

    await expect(
      test.db.forOrg(ORG_B, async (trx) => {
        await sql`insert into environments (org_id, project_id, name) values (${ORG_B}, ${projectId}, 'production')`.execute(
          trx,
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("deletes an organization's projects and environments with it", async () => {
    const test = await migrated();
    const projectId = await addProject(test, ORG_A, "Billing");
    await test.db.forOrg(ORG_A, async (trx) => {
      await sql`insert into environments (org_id, project_id, name) values (${ORG_A}, ${projectId}, 'production')`.execute(
        trx,
      );
    });

    await sql`delete from orgs where id = ${ORG_A}`.execute(test.db.global);

    const left = await test.db.system(
      "test: count what is left",
      async (trx) =>
        await sql<{ count: string }>`
          select (select count(*) from projects) + (select count(*) from environments) as count
        `.execute(trx),
    );
    expect(left.rows).toEqual([{ count: "0" }]);
  });

  it("keeps an organization's projects out of another's view", async () => {
    const test = await migrated();
    await addProject(test, ORG_A, "Billing");

    const seenByB = await test.db.forOrg(ORG_B, async (trx) => await sql`select id from projects`.execute(trx));

    expect(seenByB.rows).toEqual([]);
  });
});
