import { sql } from "kysely";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isOnPostgres, openTestDatabase, ORG_A } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { addOrgPolicy, migrate, UnknownMigrationError, UnprotectedTablesError } from "../index.js";
import type { Migration, MigrationPackage } from "../index.js";

const opened: TestDatabase[] = [];
const open = async (): Promise<TestDatabase> => {
  const test = await openTestDatabase();
  opened.push(test);
  return test;
};

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

// The migration role's URL, as the settings give it: a separate owner on Postgres, the app role's own URL on PGlite
const run = async (
  test: TestDatabase,
  packages: readonly MigrationPackage[],
  signal: AbortSignal = new AbortController().signal,
): Promise<void> => {
  await migrate(test.db, { url: test.ownerUrl ?? test.url, packages, log: test.logger }, signal);
};

const createNotesTable = (name: string, calls: string[] = []): Migration => ({
  name: `0001-${name}`,
  up: async (db) => {
    calls.push(name);
    await sql`create table ${sql.table(name)} (id serial primary key, org_id uuid not null, body text)`.execute(db);
    await addOrgPolicy(db, name);
  },
});

const tablesNamed = async (db: Kysely<unknown>, pattern: string): Promise<string[]> => {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' and tablename like ${pattern} order by tablename
  `.execute(db);
  return rows.map((row) => row.tablename);
};

// The second hub finds the lock taken and says it waits for the first
const waitUntilTheSecondWaits = async (test: TestDatabase): Promise<void> => {
  await vi.waitFor(() => {
    expect(test.log.text()).toContain("Another hub is migrating the database; waiting for it");
  });
};

describe("migrate", () => {
  it("runs each package's missing migrations in order, the packages in the order given", async () => {
    const test = await open();
    const calls: string[] = [];
    const named = (name: string): Migration => ({
      name,
      up: () => {
        calls.push(name);
        return Promise.resolve();
      },
    });

    await run(test, [
      { name: "core", migrations: [named("0001-core"), named("0002-core")] },
      { name: "debugger", migrations: [named("0001-debugger")] },
    ]);

    expect(calls).toEqual(["0001-core", "0002-core", "0001-debugger"]);
  });

  it("keeps a table of migrations run for each package", async () => {
    const test = await open();

    await run(test, [
      { name: "core", migrations: [] },
      { name: "debugger", migrations: [] },
    ]);

    expect(await tablesNamed(test.db.global, "micafox\\_migrations\\_%")).toEqual([
      "micafox_migrations_core",
      "micafox_migrations_debugger",
    ]);
  });

  it("runs only what is missing when it starts again, and runs a migration added later", async () => {
    const test = await open();
    const calls: string[] = [];
    const first = createNotesTable("first", calls);
    const second = createNotesTable("second", calls);
    await run(test, [{ name: "core", migrations: [first] }]);

    await run(test, [{ name: "core", migrations: [first, second] }]);

    expect(calls).toEqual(["first", "second"]);
  });

  it("rolls a failed migration back whole and runs it again once fixed", async () => {
    const test = await open();
    const broken: Migration = {
      name: "0001-broken",
      up: async (db) => {
        await sql`create table half_done (id int)`.execute(db);
        throw new Error("boom");
      },
    };
    await expect(run(test, [{ name: "core", migrations: [broken] }])).rejects.toThrow("boom");
    const calls: string[] = [];
    const fixed: Migration = {
      name: "0001-broken",
      up: () => {
        calls.push("fixed");
        return Promise.resolve();
      },
    };

    await run(test, [{ name: "core", migrations: [fixed] }]);

    expect(calls).toEqual(["fixed"]);
    expect(await tablesNamed(test.db.global, "half_done")).toEqual([]);
  });

  it("runs a migration that exports transaction = false outside a transaction", async () => {
    const test = await open();
    const table = createNotesTable("indexed");
    const index: Migration = {
      name: "0002-index",
      transaction: false,
      // Postgres refuses this inside a transaction block
      up: async (db) => {
        await sql`create index concurrently indexed_body_idx on indexed (body)`.execute(db);
      },
    };

    await run(test, [{ name: "core", migrations: [table, index] }]);

    const { rows } = await sql<{ indexname: string }>`
      select indexname from pg_indexes where tablename = 'indexed' and indexname = 'indexed_body_idx'
    `.execute(test.db.global);
    expect(rows).toHaveLength(1);
  });

  it("runs a failed migration without a transaction again on the next start, since nothing recorded it", async () => {
    const test = await open();
    const calls: string[] = [];
    const flaky: Migration = {
      name: "0001-flaky",
      transaction: false,
      up: () => {
        calls.push("flaky");
        return calls.length === 1 ? Promise.reject(new Error("crashed")) : Promise.resolve();
      },
    };
    await expect(run(test, [{ name: "core", migrations: [flaky] }])).rejects.toThrow("crashed");

    await run(test, [{ name: "core", migrations: [flaky] }]);

    expect(calls).toEqual(["flaky", "flaky"]);
  });

  it("fails the start when the migration role cannot connect, without running anything", async () => {
    const test = await open();
    const calls: string[] = [];

    const started = migrate(
      test.db,
      {
        url: "postgres://owner:secret@127.0.0.1:1/micafox",
        packages: [{ name: "core", migrations: [createNotesTable("never", calls)] }],
        log: test.logger,
      },
      new AbortController().signal,
    );

    await expect(started).rejects.toThrow(/ECONNREFUSED|connect/);
    expect(calls).toEqual([]);
  });

  it("refuses a database a newer hub migrated, before it runs anything, saying so", async () => {
    const test = await open();
    const calls: string[] = [];
    const known = createNotesTable("known", calls);
    const newer: Migration = { name: "0002-newer", up: () => Promise.resolve() };
    await run(test, [{ name: "core", migrations: [known, newer] }]);
    const added = createNotesTable("added", calls);

    const olderHub = run(test, [
      { name: "core", migrations: [known] },
      { name: "debugger", migrations: [added] },
    ]);

    await expect(olderHub).rejects.toThrow(UnknownMigrationError);
    await expect(olderHub).rejects.toThrow(/0002-newer of core.*a newer hub migrated it/);
    expect(calls).toEqual(["known"]);
  });

  it("stops before the next migration when the hub stops", async () => {
    const test = await open();
    const calls: string[] = [];
    const stopper = new AbortController();
    const first: Migration = {
      name: "0001-first",
      up: () => {
        calls.push("first");
        stopper.abort();
        return Promise.resolve();
      },
    };
    const second: Migration = {
      name: "0002-second",
      up: () => {
        calls.push("second");
        return Promise.resolve();
      },
    };

    await expect(run(test, [{ name: "core", migrations: [first, second] }], stopper.signal)).rejects.toThrow("aborted");

    expect(calls).toEqual(["first"]);
  });

  it("logs each migration it ran", async () => {
    const test = await open();

    await run(test, [{ name: "core", migrations: [createNotesTable("logged")] }]);

    expect(test.log.lines()).toContainEqual(
      expect.objectContaining({ msg: "db.migrated", package: "core", migration: "0001-logged" }),
    );
  });
});

describe("migrate checking row-level security", () => {
  const unprotected: Array<[string, string[]]> = [
    ["has no org_id", ["create table {t} (id int)"]],
    ["has org_id but no row-level security", ["create table {t} (id int, org_id uuid)"]],
    [
      "has RLS enabled but not forced",
      ["create table {t} (id int, org_id uuid)", "alter table {t} enable row level security"],
    ],
    [
      "forces RLS but has no org_id",
      [
        "create table {t} (id int)",
        "alter table {t} enable row level security",
        "alter table {t} force row level security",
      ],
    ],
  ];

  it.each(unprotected)("fails the start, naming the table, when a table %s", async (_case, statements) => {
    const test = await open();
    const migration: Migration = {
      name: "0001-leaky",
      up: async (db) => {
        for (const statement of statements) {
          await sql.raw(statement.replaceAll("{t}", "leaky")).execute(db);
        }
      },
    };

    const started = run(test, [{ name: "debugger", migrations: [migration] }]);

    await expect(started).rejects.toThrow(UnprotectedTablesError);
    await expect(started).rejects.toThrow(/: leaky$/);
  });

  it("accepts a table with org_id under forced row-level security, and the global tables without it", async () => {
    const test = await open();
    const global: Migration = {
      name: "0001-users",
      up: async (db) => {
        await sql`create table users (id uuid primary key)`.execute(db);
      },
    };

    await run(test, [
      { name: "core", migrations: [global] },
      { name: "debugger", migrations: [createNotesTable("notes")] },
    ]);

    expect(await tablesNamed(test.db.global, "%")).toContain("users");
  });
});

describe.runIf(isOnPostgres)("migrate on Postgres", () => {
  it("lets the app role use what a separate owner role created, but not its migrations tables, nor switch a table's row-level security off", async () => {
    const test = await open();
    await run(test, [{ name: "core", migrations: [createNotesTable("notes")] }]);

    await test.db.forOrg(ORG_A, async (trx) => {
      await sql`insert into notes (org_id, body) values (${ORG_A}, 'hello')`.execute(trx);
    });

    const notes = await test.db.forOrg(ORG_A, async (trx) => await sql`select body from notes`.execute(trx));
    expect(notes.rows).toEqual([{ body: "hello" }]);
    await expect(sql`select * from micafox_migrations_core`.execute(test.db.global)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`alter table notes disable row level security`.execute(test.db.global)).rejects.toThrow(
      /must be owner/,
    );
  });

  it("migrates as the app role when no owner role is set", async () => {
    const test = await open();

    await migrate(
      test.db,
      { url: test.url, packages: [{ name: "core", migrations: [createNotesTable("notes")] }], log: test.logger },
      new AbortController().signal,
    );

    expect(await tablesNamed(test.db.global, "notes")).toEqual(["notes"]);
  });

  it("never runs a migration twice when two hubs start at once, the second waiting for the first", async () => {
    const test = await open();
    let calls = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Migration = {
      name: "0001-slow",
      up: async (db) => {
        calls += 1;
        await gate;
        await sql`create table slow (id int, org_id uuid)`.execute(db);
        await addOrgPolicy(db, "slow");
      },
    };
    const packages = [{ name: "core", migrations: [slow] }];
    const first = run(test, packages);
    const second = run(test, packages);

    await waitUntilTheSecondWaits(test);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  it("ends the wait for another hub's lock when the hub stops", async () => {
    const test = await open();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: Migration = {
      name: "0001-held",
      up: async () => {
        await gate;
      },
    };
    const first = run(test, [{ name: "core", migrations: [held] }]);
    const stopper = new AbortController();
    const second = run(test, [{ name: "core", migrations: [held] }], stopper.signal);
    await waitUntilTheSecondWaits(test);

    stopper.abort();

    await expect(second).rejects.toThrow("aborted");
    release();
    await first;
  });
});
