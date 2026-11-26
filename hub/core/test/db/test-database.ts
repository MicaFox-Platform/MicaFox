import { sql } from "kysely";
import type { Kysely } from "kysely";
import { randomBytes } from "node:crypto";
import pg from "pg";
import pino from "pino";
import type { Logger } from "pino";
import { inject } from "vitest";

import { addOrgPolicy, createDatabase } from "../../src/server/db/index.js";
import type { Database } from "../../src/server/db/index.js";
import { captureLog } from "../server/log-capture.js";
import type { LogCapture } from "../server/log-capture.js";

/**
 * A superuser URL of a Postgres to run the database tests on; without it they run on PGlite. Each test file gets a
 * database and a role of its own there, dropped when it closes.
 */
export const TEST_DATABASE_URL = process.env.MICAFOX_TEST_DATABASE_URL;

/** Whether the tests run on Postgres, which tests that need several connections require. */
export const isOnPostgres = TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== "";

export const ORG_A = "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01";
export const ORG_B = "4d1e9c07-21b4-4f0a-8c3e-0a9f7e5d6b02";

/** A database for one test file, as the app role, with what it logged. */
export interface TestDatabase {
  db: Database;
  /** The app role's URL: the settings URL a hub would get. */
  url: string;
  /** On Postgres, the URL of a separate owner role that may create tables, as `MICAFOX_MIGRATION_DATABASE_URL` is. */
  ownerUrl: string | undefined;
  log: LogCapture;
  /** The logger the database writes to, which `log` captures. */
  logger: Logger;
  /** On Postgres, gives the app role an attribute, as an operator could by mistake; PGlite has no such role. */
  alterRole: (attribute: "bypassrls") => Promise<void>;
  /** Settles with the next collapsed warning the database gives. */
  nextWarning: () => Promise<Warning>;
  close: () => Promise<void>;
}

/** A collapsed warning: its key and fields. */
export interface Warning {
  key: string;
  fields: Record<string, unknown>;
}

interface PostgresScratch {
  url: string;
  ownerUrl: string;
  alterRole: TestDatabase["alterRole"];
  drop: () => Promise<void>;
}

const asAdmin = async (adminUrl: string, statements: readonly string[]): Promise<void> => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const statement of statements) {
      await admin.query(statement);
    }
  } finally {
    await admin.end();
  }
};

const urlOf = (adminUrl: string, login: { name: string; password: string; database: string }): string => {
  const url = new URL(adminUrl);
  url.username = login.name;
  url.password = login.password;
  url.pathname = `/${login.database}`;
  return url.toString();
};

// One database, an app role that owns it and a second role for migrations, per file, named alike, since test files
// run in parallel on one server. The migration role gets no more than an operator's init script would give it.
const createPostgresScratch = async (adminUrl: string): Promise<PostgresScratch> => {
  const name = `micafox_test_${randomBytes(6).toString("hex")}`;
  const ownerName = `${name}_owner`;
  const password = randomBytes(12).toString("hex");
  await asAdmin(adminUrl, [
    `create role ${name} login password '${password}' nosuperuser nobypassrls`,
    `create role ${ownerName} login password '${password}' nosuperuser nobypassrls`,
    `create database ${name} owner ${name}`,
  ]);
  const inDatabase = new URL(adminUrl);
  inDatabase.pathname = `/${name}`;
  await asAdmin(inDatabase.toString(), [`grant usage, create on schema public to ${ownerName}`]);
  return {
    url: urlOf(adminUrl, { name, password, database: name }),
    ownerUrl: urlOf(adminUrl, { name: ownerName, password, database: name }),
    alterRole: async (attribute) => {
      await asAdmin(adminUrl, [`alter role ${name} ${attribute}`]);
    },
    drop: async () => {
      await asAdmin(adminUrl, [`drop database ${name} with (force)`, `drop role ${name}`, `drop role ${ownerName}`]);
    },
  };
};

/**
 * Opens the test database: PGlite in memory, or a scratch database on `MICAFOX_TEST_DATABASE_URL`. A `migrated` one on
 * PGlite starts from the seed with hub-core's migrations run, so migrating it again finds nothing to run; on Postgres
 * it starts empty, and the caller's migration runs them.
 */
export const openTestDatabase = async (
  options: { poolSize?: number; migrated?: boolean } = {},
): Promise<TestDatabase> => {
  const scratch =
    isOnPostgres && TEST_DATABASE_URL !== undefined ? await createPostgresScratch(TEST_DATABASE_URL) : undefined;
  const url = scratch?.url ?? "pglite:memory";
  const log = captureLog();
  const waiting: Array<(warning: Warning) => void> = [];
  const logger = pino({ level: "debug" }, log.stream);
  const db = createDatabase({
    url,
    ...(options.migrated === true && scratch === undefined ? { pgliteSeed: inject("pgliteSeed") } : {}),
    poolSize: options.poolSize ?? 10,
    log: logger,
    warnCollapsed: (key, fields) => {
      waiting.shift()?.({ key, fields });
    },
  });
  return {
    db,
    url,
    ownerUrl: scratch?.ownerUrl,
    log,
    logger,
    alterRole: async (attribute) => {
      if (scratch === undefined) {
        throw new Error("PGlite has no app role to alter");
      }
      await scratch.alterRole(attribute);
    },
    nextWarning: async () =>
      await new Promise<Warning>((resolve) => {
        waiting.push(resolve);
      }),
    close: async () => {
      await db.close();
      await scratch?.drop();
    },
  };
};

/** Creates `notes` with its organization policy, as the app role, which then owns it. */
export const createNotes = async (db: Database): Promise<void> => {
  await sql`create table notes (id serial primary key, org_id uuid not null, body text not null)`.execute(db.global);
  await addOrgPolicy(db.global, "notes");
};

/** Adds a note of `orgId` through its own scope. */
export const addNote = async (db: Database, orgId: string, body: string): Promise<void> => {
  await db.forOrg(orgId, async (trx) => {
    await sql`insert into notes (org_id, body) values (${orgId}, ${body})`.execute(trx);
  });
};

/** The bodies of the notes a handle sees, in order. */
export const bodiesSeenBy = async (handle: Kysely<unknown>): Promise<string[]> => {
  const { rows } = await sql<{ body: string }>`select body from notes order by body`.execute(handle);
  return rows.map((row) => row.body);
};

/** The bodies of the notes that `orgId` sees. */
export const notesOf = async (db: Database, orgId: string): Promise<string[]> =>
  await db.forOrg(orgId, async (trx) => await bodiesSeenBy(trx));
