import { sql } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyFeature, paidFeature } from "../../../../test/feature/fixtures.js";
import { envOf, TEST_MODE_LINES } from "../../../../test/server/env.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import { addOrgPolicy, createDatabase } from "../../db/index.js";
import type { Migration } from "../../db/index.js";
import { defineExtension } from "../../feature/index.js";
import type { RunHubProcess } from "../index.js";
import { runMigrations } from "../index.js";

interface Fixture {
  proc: RunHubProcess;
  signal: (name: "SIGTERM" | "SIGINT") => void;
  exits: number[];
  log: ReturnType<typeof captureLog>;
  stderr: () => string;
}

const createProcess = (lines: readonly string[]): Fixture => {
  const log = captureLog();
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const errors: string[] = [];
  return {
    proc: {
      env: envOf(lines),
      stdout: log.stream,
      stderr: {
        write: (text) => {
          errors.push(text);
        },
      },
      on: (signal, listener) => handlers.set(signal, listener),
      exit: (code) => {
        exits.push(code);
      },
    },
    exits,
    log,
    stderr: () => errors.join(""),
    signal: (name) => {
      handlers.get(name)?.();
    },
  };
};

// A migration that adds a table of an organization's rows, which the hub requires to be under row-level security
const createTable = (name: string, table: string): Migration => ({
  name,
  up: async (db) => {
    await sql`create table ${sql.table(table)} (id uuid primary key, org_id uuid not null references orgs (id))`.execute(
      db,
    );
    await addOrgPolicy(db, table);
  },
});

const folders: string[] = [];

const createFolder = async (): Promise<string> => {
  const folder = await mkdtemp(path.join(tmpdir(), "micafox-migrate-"));
  folders.push(folder);
  return folder;
};

const withDatabase = (url: string): string[] => [
  ...TEST_MODE_LINES.filter((line) => !line.startsWith("MICAFOX_DATABASE_URL")),
  `MICAFOX_DATABASE_URL=${url}`,
];

// As a newer hub would have left it: a migration of hub-core this build does not know
const recordFutureMigration = async (folder: string): Promise<void> => {
  const db = createDatabase({
    url: `pglite:${folder}`,
    poolSize: 1,
    log: pino({ level: "silent" }),
    warnCollapsed: () => undefined,
  });
  await db.system("test: a newer hub's migration", async (trx) => {
    await sql`insert into micafox_migrations_core (name) values ('9999-future')`.execute(trx);
  });
  await db.close();
};

// Nothing listens on port 1, so every connection is refused at once and the wait retries
const UNREACHABLE_LINES = [
  "MICAFOX_DATABASE_URL=postgres://micafox:secret@127.0.0.1:1/micafox",
  "MICAFOX_PUBLIC_URL=http://localhost:8080",
];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    folders.splice(0).map(async (folder) => {
      await rm(folder, { recursive: true, force: true });
    }),
  );
});

describe("runMigrations", () => {
  it("runs the missing migrations and exits with 0", async () => {
    const { proc, exits, log } = createProcess(TEST_MODE_LINES);

    await runMigrations({ features: [] }, proc);

    expect(exits).toEqual([0]);
    expect(log.lines().map((line) => line.msg)).toEqual(expect.arrayContaining(["db.migrated", "db.migrations-done"]));
  });

  it("keeps a pglite:<folder> migrated after it exits, so the next run has nothing to do", async () => {
    const url = `pglite:${await createFolder()}`;
    await runMigrations({ features: [] }, createProcess(withDatabase(url)).proc);
    const again = createProcess(withDatabase(url));

    await runMigrations({ features: [] }, again.proc);

    expect(again.exits).toEqual([0]);
    expect(again.log.lines().map((line) => line.msg)).not.toContain("db.migrated");
  });

  it("prints every settings problem and exits with 1 without logging", async () => {
    const { proc, exits, log, stderr } = createProcess(["MICAFOX_DATABASE_URL=mysql://app:hunter2@db/hub"]);

    await runMigrations({ features: [] }, proc);

    expect(exits).toEqual([1]);
    expect(stderr()).toContain("MICAFOX_DATABASE_URL: must be a postgres:// URL");
    expect(stderr()).not.toContain("hunter2");
    expect(log.text()).toBe("");
  });

  it("runs the migrations of the features and of the extension after hub-core's, each as its own package", async () => {
    const { proc, exits, log } = createProcess(TEST_MODE_LINES);
    const notes = emptyFeature("notes", { migrations: [createTable("0001-notes", "notes")] });
    const logs = paidFeature("logs", { migrations: [createTable("0001-logs", "log_lines")] });

    await runMigrations({ features: [notes], extension: defineExtension({ features: [logs] }) }, proc);

    expect(exits).toEqual([0]);
    expect(
      log
        .lines()
        .filter((line) => line.msg === "db.migrated" && line.package !== "core")
        .map((line) => [line.package, line.migration]),
    ).toEqual([
      ["notes", "0001-notes"],
      ["logs", "0001-logs"],
    ]);
    expect(log.lines().find((line) => line.msg === "db.migrated")?.package).toBe("core");
  });

  it("prints every conflict of the features, exits with 1 and runs nothing", async () => {
    const { proc, exits, stderr, log } = createProcess(TEST_MODE_LINES);

    await runMigrations({ features: [emptyFeature("notes"), emptyFeature("notes")] }, proc);

    expect(exits).toEqual([1]);
    expect(stderr()).toContain('Two features are named "notes"');
    expect(log.text()).toBe("");
  });

  it("exits with 1 when a newer hub migrated the database", async () => {
    const folder = await createFolder();
    await runMigrations({ features: [] }, createProcess(withDatabase(`pglite:${folder}`)).proc);
    await recordFutureMigration(folder);
    const { proc, exits, log } = createProcess(withDatabase(`pglite:${folder}`));

    await runMigrations({ features: [] }, proc);

    expect(exits).toEqual([1]);
    expect(log.lines()).toContainEqual(expect.objectContaining({ level: "error", msg: "The migrations failed" }));
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "stops waiting for an unreachable database on %s and exits with 1",
    async (name) => {
      vi.useFakeTimers();
      const { proc, exits, log, signal } = createProcess(UNREACHABLE_LINES);
      const running = runMigrations({ features: [] }, proc);
      await vi.waitFor(() => {
        expect(log.text()).toContain("db.unreachable");
      });

      signal(name);
      await running;

      expect(exits).toEqual([1]);
      expect(log.lines()).toContainEqual(
        expect.objectContaining({ level: "error", msg: "The migrations were stopped by a signal" }),
      );
    },
  );

  it("exits with 1 at once on a second signal", async () => {
    vi.useFakeTimers();
    const { proc, exits, log, signal } = createProcess(UNREACHABLE_LINES);
    const running = runMigrations({ features: [] }, proc);
    await vi.waitFor(() => {
      expect(log.text()).toContain("db.unreachable");
    });

    signal("SIGTERM");
    signal("SIGINT");

    expect(exits).toEqual([1]);
    await running;
  });

  it("exits with 1 when the migrations do not stop within 30 s of the signal", async () => {
    vi.useFakeTimers();
    const { proc, exits, log, signal } = createProcess(UNREACHABLE_LINES);
    const running = runMigrations({ features: [] }, proc);
    await vi.waitFor(() => {
      expect(log.text()).toContain("db.unreachable");
    });

    signal("SIGTERM");
    vi.advanceTimersByTime(30_000);

    expect(exits).toEqual([1]);
    await running;
  });
});
