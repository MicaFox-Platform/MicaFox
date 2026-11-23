import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { addNote, createNotes, openTestDatabase, ORG_A } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { ORG_POLICY } from "../index.js";

const opened: TestDatabase[] = [];

const openWithNotes = async (): Promise<TestDatabase> => {
  const test = await openTestDatabase();
  opened.push(test);
  await createNotes(test.db);
  return test;
};

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

describe("addOrgPolicy", () => {
  it("enables and forces row-level security with the organization policy", async () => {
    const { db } = await openWithNotes();

    const { rows } = await sql<{ enabled: boolean; forced: boolean; policies: string[] }>`
      select relrowsecurity as enabled, relforcerowsecurity as forced,
        array(select polname::text from pg_policy where polrelid = pg_class.oid) as policies
      from pg_class where oid = 'notes'::regclass
    `.execute(db.global);

    expect(rows).toEqual([{ enabled: true, forced: true, policies: [ORG_POLICY] }]);
  });

  it("hides the rows from the table's owner, which the app role is", async () => {
    const { db } = await openWithNotes();
    await addNote(db, ORG_A, "a1");

    const { rows } = await sql<{ isOwner: boolean; visible: string }>`
      select pg_get_userbyid(relowner) = current_user as "isOwner", (select count(*) from notes) as visible
      from pg_class where oid = 'notes'::regclass
    `.execute(db.global);

    expect(rows).toEqual([{ isOwner: true, visible: "0" }]);
  });
});
