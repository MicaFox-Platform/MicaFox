import { sql } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { envOf, TEST_MODE_LINES } from "../../../../test/server/env.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import { createDatabase } from "../../db/index.js";
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

    await runMigrations({}, proc);

    expect(exits).toEqual([0]);
    expect(log.lines().map((line) => line.msg)).toEqual(expect.arrayContaining(["db.migrated", "db.migrations-done"]));
  });

  it("keeps a pglite:<folder> migrated after it exits, so the next run has nothing to do", async () => {
    const url = `pglite:${await createFolder()}`;
    await runMigrations({}, createProcess(withDatabase(url)).proc);
    const again = createProcess(withDatabase(url));

    await runMigrations({}, again.proc);

    expect(again.exits).toEqual([0]);
    expect(again.log.lines().map((line) => line.msg)).not.toContain("db.migrated");
  });

  it("prints every settings problem and exits with 1 without logging", async () => {
    const { proc, exits, log, stderr } = createProcess(["MICAFOX_DATABASE_URL=mysql://app:hunter2@db/hub"]);

    await runMigrations({}, proc);

    expect(exits).toEqual([1]);
    expect(stderr()).toContain("MICAFOX_DATABASE_URL: must be a postgres:// URL");
    expect(stderr()).not.toContain("hunter2");
    expect(log.text()).toBe("");
  });

  it("exits with 1 when a newer hub migrated the database", async () => {
    const folder = await createFolder();
    await runMigrations({}, createProcess(withDatabase(`pglite:${folder}`)).proc);
    await recordFutureMigration(folder);
    const { proc, exits, log } = createProcess(withDatabase(`pglite:${folder}`));

    await runMigrations({}, proc);

    expect(exits).toEqual([1]);
    expect(log.lines()).toContainEqual(expect.objectContaining({ level: "error", msg: "The migrations failed" }));
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "stops waiting for an unreachable database on %s and exits with 1",
    async (name) => {
      vi.useFakeTimers();
      const { proc, exits, log, signal } = createProcess(UNREACHABLE_LINES);
      const running = runMigrations({}, proc);
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
    const running = runMigrations({}, proc);
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
    const running = runMigrations({}, proc);
    await vi.waitFor(() => {
      expect(log.text()).toContain("db.unreachable");
    });

    signal("SIGTERM");
    vi.advanceTimersByTime(30_000);

    expect(exits).toEqual([1]);
    await running;
  });
});
