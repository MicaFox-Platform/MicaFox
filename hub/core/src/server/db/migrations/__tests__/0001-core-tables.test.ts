import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openTestDatabase } from "../../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../../test/db/test-database.js";
import { migrate } from "../../index.js";
import type { MigrationPackage } from "../../index.js";
import * as m0001 from "../0001-core-tables.js";

// Only this migration, so what later ones add does not change what it is tested for
const FIRST_MIGRATION: MigrationPackage = { name: "core", migrations: [m0001] };

const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

const migrated = async (): Promise<TestDatabase> => {
  const test = await openTestDatabase();
  opened.push(test);
  await migrate(
    test.db,
    { url: test.ownerUrl ?? test.url, packages: [FIRST_MIGRATION], log: test.logger },
    new AbortController().signal,
  );
  return test;
};

const insertOrg = async (test: TestDatabase, name: string): Promise<string> => {
  const { rows } = await sql<{ id: string }>`insert into orgs (name) values (${name}) returning id`.execute(
    test.db.global,
  );
  return rows[0]?.id ?? "";
};

const insertUser = async (test: TestDatabase, email: string): Promise<string> => {
  const { rows } = await sql<{ id: string }>`
    insert into users (email, name, password_hash) values (${email}, 'Ada', 'scrypt$hash') returning id
  `.execute(test.db.global);
  return rows[0]?.id ?? "";
};

describe("hub-core's first migration", () => {
  it("creates orgs, users, memberships, sessions, credentials and settings", async () => {
    const test = await migrated();

    const { rows } = await sql<{ tablename: string }>`
      select tablename from pg_tables where schemaname = 'public' and tablename not like 'micafox\\_migrations\\_%'
      order by tablename
    `.execute(test.db.global);

    expect(rows.map((row) => row.tablename)).toEqual([
      "credentials",
      "memberships",
      "orgs",
      "sessions",
      "settings",
      "users",
    ]);
  });

  it("lets the app role read and write them, with their ids and times generated", async () => {
    const test = await migrated();

    const orgId = await insertOrg(test, "Acme");
    const userId = await insertUser(test, "ada@example.com");
    await sql`insert into memberships (user_id, org_id, role) values (${userId}, ${orgId}, 'owner')`.execute(
      test.db.global,
    );
    await sql`insert into sessions (token_hash, user_id) values ('a1b2', ${userId})`.execute(test.db.global);
    await sql`insert into credentials (kind, token_hash, org_id) values ('project-key', 'c3d4', ${orgId})`.execute(
      test.db.global,
    );
    await sql`insert into settings (key, value) values ('owner-exists', 'true')`.execute(test.db.global);

    const { rows } = await sql<{ role: string }>`select role from memberships where user_id = ${userId}`.execute(
      test.db.global,
    );
    expect(rows).toEqual([{ role: "owner" }]);
  });

  it("refuses a second user with an email that differs only in case", async () => {
    const test = await migrated();
    await insertUser(test, "ada@example.com");

    await expect(insertUser(test, "ADA@example.com")).rejects.toThrow(/users_email_key/);
  });

  it("refuses a second owner in one organization, and an unknown role", async () => {
    const test = await migrated();
    const orgId = await insertOrg(test, "Acme");
    const ada = await insertUser(test, "ada@example.com");
    const grace = await insertUser(test, "grace@example.com");
    await sql`insert into memberships (user_id, org_id, role) values (${ada}, ${orgId}, 'owner')`.execute(
      test.db.global,
    );

    const secondOwner = sql`insert into memberships (user_id, org_id, role) values (${grace}, ${orgId}, 'owner')`;
    const unknownRole = sql`insert into memberships (user_id, org_id, role) values (${grace}, ${orgId}, 'root')`;

    await expect(secondOwner.execute(test.db.global)).rejects.toThrow(/memberships_one_owner/);
    await expect(unknownRole.execute(test.db.global)).rejects.toThrow(/memberships_role_check/);
  });

  it("deletes a user's sessions and memberships with the user", async () => {
    const test = await migrated();
    const orgId = await insertOrg(test, "Acme");
    const userId = await insertUser(test, "ada@example.com");
    await sql`insert into memberships (user_id, org_id, role) values (${userId}, ${orgId}, 'member')`.execute(
      test.db.global,
    );
    await sql`insert into sessions (token_hash, user_id) values ('a1b2', ${userId})`.execute(test.db.global);

    await sql`delete from users where id = ${userId}`.execute(test.db.global);

    const { rows } = await sql<{ left: string }>`
      select (select count(*) from sessions) + (select count(*) from memberships) as left
    `.execute(test.db.global);
    expect(rows).toEqual([{ left: "0" }]);
  });
});
