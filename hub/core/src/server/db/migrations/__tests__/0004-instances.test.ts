import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openTestDatabase, ORG_A, ORG_B } from "../../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../../test/db/test-database.js";
import {
  addEnvironment,
  addOfflineInstances,
  readInstances,
} from "../../../../../test/sdk-endpoint/instances-database.js";
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
  await test.db.system("test: add the organizations", async (trx) => {
    await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme'), (${ORG_B}, 'Globex')`.execute(trx);
  });
  return test;
};

describe("the instances migration", () => {
  it("keeps the rows of an organization from another, for reads and writes", async () => {
    const test = await migrated();
    const scope = await addEnvironment(test.db, ORG_A);
    await addOfflineInstances(test.db, scope, { count: 2, firstSeenAt: new Date() });

    const seenByB = await test.db.forOrg(ORG_B, async (trx) => {
      const { rows } = await sql`select 1 from instances`.execute(trx);
      return rows.length;
    });
    const writeByB = test.db.forOrg(ORG_B, async (trx) => {
      await sql`insert into instances (org_id, project_id, environment_id, instance_id, hostname, pid, sdk_name,
        sdk_version, runtime_name, runtime_version, protocol_version, key_prefix, connected_at, last_seen_at)
        values (${ORG_A}, ${scope.projectId}, ${scope.environmentId}, 'x', 'h', 1, 's', '1', 'n', '1', 1, 'p', now(), now())`.execute(
        trx,
      );
    });

    expect(seenByB).toBe(0);
    await expect(writeByB).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses an instance whose organization or project disagrees with its environment's", async () => {
    const test = await migrated();
    const scope = await addEnvironment(test.db, ORG_A);

    const wrong = test.db.system("test: a row of the wrong organization", async (trx) => {
      await sql`insert into instances (org_id, project_id, environment_id, instance_id, hostname, pid, sdk_name,
        sdk_version, runtime_name, runtime_version, protocol_version, key_prefix, connected_at, last_seen_at)
        values (${ORG_B}, ${scope.projectId}, ${scope.environmentId}, 'x', 'h', 1, 's', '1', 'n', '1', 1, 'p', now(), now())`.execute(
        trx,
      );
    });

    await expect(wrong).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a second row for the same environment and instanceId", async () => {
    const test = await migrated();
    const scope = await addEnvironment(test.db, ORG_A);
    await addOfflineInstances(test.db, scope, { count: 1, firstSeenAt: new Date() });

    const again = addOfflineInstances(test.db, scope, { count: 1, firstSeenAt: new Date() });

    await expect(again).rejects.toMatchObject({ code: "23505" });
  });

  it("deletes the instances with their environment", async () => {
    const test = await migrated();
    const scope = await addEnvironment(test.db, ORG_A);
    await addOfflineInstances(test.db, scope, { count: 2, firstSeenAt: new Date() });

    await test.db.system("test: delete the environment", async (trx) => {
      await sql`delete from environments where id = ${scope.environmentId}`.execute(trx);
    });

    expect(await readInstances(test.db, scope.environmentId)).toEqual([]);
  });
});
