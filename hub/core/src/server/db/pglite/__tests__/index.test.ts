import { sql } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { addNote, createNotes, notesOf, ORG_A } from "../../../../../test/db/test-database.js";
import { captureLog } from "../../../../../test/server/log-capture.js";
import type { LogCapture } from "../../../../../test/server/log-capture.js";
import { APP_ROLE, createDatabase } from "../../index.js";
import type { Database } from "../../index.js";

const opened: Database[] = [];
const folders: string[] = [];

const open = (url: string, log: LogCapture = captureLog()): Database => {
  const db = createDatabase({ url, poolSize: 10, log: pino({}, log.stream), warnCollapsed: () => undefined });
  opened.push(db);
  return db;
};

const createFolder = async (): Promise<string> => {
  const folder = await mkdtemp(path.join(tmpdir(), "micafox-pglite-"));
  folders.push(folder);
  return folder;
};

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (db) => {
      await db.close();
    }),
  );
  await Promise.all(
    folders.splice(0).map(async (folder) => {
      await rm(folder, { recursive: true, force: true });
    }),
  );
});

describe("pglite:memory", () => {
  it("runs as the app role, which is no superuser and does not bypass row-level security", async () => {
    const db = open("pglite:memory");

    const { rows } = await sql<{ role: string; isSuperuser: boolean; bypassesRls: boolean }>`
      select current_user as role, rolsuper as "isSuperuser", rolbypassrls as "bypassesRls"
      from pg_roles where rolname = current_user
    `.execute(db.global);

    expect(rows).toEqual([{ role: APP_ROLE, isSuperuser: false, bypassesRls: false }]);
  });

  it("logs that PGlite is not for production once it opens", async () => {
    const log = captureLog();
    const db = open("pglite:memory", log);

    await sql`select 1`.execute(db.global);

    expect(log.lines()).toEqual([
      expect.objectContaining({
        level: 40,
        database: "pglite:memory",
        msg: expect.stringContaining("not for production") as unknown,
      }),
    ]);
  });
});

describe("pglite:<folder>", () => {
  it("keeps its rows and its app role when the folder is opened again", async () => {
    const folder = await createFolder();
    const first = open(`pglite:${folder}`);
    await createNotes(first);
    await addNote(first, ORG_A, "kept");
    await first.close();

    const again = open(`pglite:${folder}`);

    await expect(notesOf(again, ORG_A)).resolves.toEqual(["kept"]);
  });
});
