import { sql } from "kysely";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { captureLog } from "../../../../test/server/log-capture.js";
import type { LogCapture } from "../../../../test/server/log-capture.js";
import { buildPgliteSeed, CORE_MIGRATIONS, createDatabase, migrate } from "../index.js";
import type { Database, MigrationPackage } from "../index.js";

const opened: Database[] = [];
const folders: string[] = [];
let seed = "";

const createFolder = async (): Promise<string> => {
  const folder = await mkdtemp(path.join(tmpdir(), "micafox-seed-"));
  folders.push(folder);
  return folder;
};

const open = (url: string, options: { seed?: string; log?: LogCapture } = {}): Database => {
  const log = options.log ?? captureLog();
  const db = createDatabase({
    url,
    poolSize: 1,
    log: pino({}, log.stream),
    warnCollapsed: () => undefined,
    ...(options.seed === undefined ? {} : { pgliteSeed: options.seed }),
  });
  opened.push(db);
  return db;
};

// Migrates as a start does and returns the migrations it ran, from its `db.migrated` lines
const migrateAndList = async (
  url: string,
  packages: readonly MigrationPackage[],
  seedFile = seed,
): Promise<string[]> => {
  const log = captureLog();
  const db = open(url, { seed: seedFile, log });
  await migrate(db, { url, packages, log: pino({}, log.stream) }, new AbortController().signal);
  return log
    .lines()
    .filter((line) => line.msg === "db.migrated")
    .map((line) => `${String(line.package)}/${String(line.migration)}`);
};

const EXTRA: MigrationPackage = {
  name: "extra",
  migrations: [
    {
      name: "0001-extra",
      up: async (db) => {
        await sql`select 1`.execute(db);
      },
    },
  ],
};

const tablesOf = async (db: Database): Promise<string[]> => {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `.execute(db.global);
  return rows.map((row) => row.tablename);
};

beforeAll(async () => {
  seed = path.join(await createFolder(), "pglite-seed.tar.gz");
  await buildPgliteSeed({ file: seed, log: pino({ level: "silent" }) });
});

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (db) => {
      await db.close();
    }),
  );
});

afterAll(async () => {
  await Promise.all(
    folders.splice(0).map(async (folder) => {
      await rm(folder, { recursive: true, force: true });
    }),
  );
});

describe("buildPgliteSeed", () => {
  it("makes pglite:memory start with every migration applied, so a start runs none", async () => {
    const ran = await migrateAndList("pglite:memory", [CORE_MIGRATIONS]);

    expect(ran).toEqual([]);
  });

  it("makes a new pglite:<folder> start with every migration applied, so a start runs none", async () => {
    const folder = path.join(await createFolder(), "data");

    const ran = await migrateAndList(`pglite:${folder}`, [CORE_MIGRATIONS]);

    expect(ran).toEqual([]);
  });

  it("leaves a start from the seed only the migrations the seed does not hold", async () => {
    const ran = await migrateAndList("pglite:memory", [CORE_MIGRATIONS, EXTRA]);

    expect(ran).toEqual(["extra/0001-extra"]);
  });

  it("holds the features' migrations it is given, so a start from it runs none of them either", async () => {
    const withExtra = path.join(await createFolder(), "pglite-seed.tar.gz");
    await buildPgliteSeed({ file: withExtra, log: pino({ level: "silent" }), packages: [EXTRA] });

    const ran = await migrateAndList("pglite:memory", [CORE_MIGRATIONS, EXTRA], withExtra);

    expect(ran).toEqual([]);
  });

  it("holds the core tables, as the app role can read them", async () => {
    const db = open("pglite:memory", { seed });

    await expect(tablesOf(db)).resolves.toEqual(
      expect.arrayContaining(["credentials", "memberships", "orgs", "sessions", "settings", "users"]),
    );
  });

  it("rejects when the seed cannot be written, as the build then fails", async () => {
    const blocker = path.join(await createFolder(), "a-file");
    await writeFile(blocker, "");

    await expect(
      buildPgliteSeed({ file: path.join(blocker, "pglite-seed.tar.gz"), log: pino({ level: "silent" }) }),
    ).rejects.toThrow(/EEXIST|ENOTDIR/);
  });
});

describe("a PGlite seed", () => {
  it("is not loaded into a folder that already holds a database", async () => {
    const folder = await createFolder();
    const first = open(`pglite:${folder}`);
    await sql`create table kept (id int)`.execute(first.global);
    await first.close();

    const again = open(`pglite:${folder}`, { seed });

    await expect(tablesOf(again)).resolves.toEqual(["kept"]);
  });

  it("when missing, leaves an empty database that runs every migration, and says so", async () => {
    const log = captureLog();
    const missing = path.join(await createFolder(), "missing.tar.gz");
    const db = open("pglite:memory", { seed: missing, log });

    await expect(tablesOf(db)).resolves.toEqual([]);
    expect(log.lines()).toContainEqual(
      expect.objectContaining({ level: 40, seed: missing, msg: expect.stringContaining("seed is missing") as unknown }),
    );
  });
});
