import { CamelCasePlugin } from "kysely";
import type { Generated, Kysely } from "kysely";

import type { HubTables } from "../../db/index.js";
import type { Role } from "../authorization/index.js";

/** `orgs`, with the columns in camelCase. */
export interface OrgsTable {
  id: Generated<string>;
  name: string;
  createdAt: Generated<Date>;
}

/** `users`: the password is kept as a `password/` hash. */
export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Generated<Date>;
}

/** `memberships`: one role of a user in an organization. */
export interface MembershipsTable {
  userId: string;
  orgId: string;
  role: Role;
  createdAt: Generated<Date>;
}

/** `sessions`, found by the SHA-256 of the cookie's value. */
export interface SessionsTable {
  tokenHash: string;
  userId: string;
  createdAt: Generated<Date>;
  lastUsedAt: Generated<Date>;
}

/** `credentials`, of which access reads only the setup token; the other kinds come with their features. */
export interface CredentialsTable {
  id: Generated<string>;
  kind: "setup";
  tokenHash: string;
}

/** The tables without an organization's rows that access reads and writes; `Record` since Kysely wants an index signature. */
export type GlobalTables = Record<"orgs", OrgsTable> &
  Record<"users", UsersTable> &
  Record<"memberships", MembershipsTable> &
  Record<"sessions", SessionsTable> &
  Record<"credentials", CredentialsTable>;

/** How emails compare, as the unique index on `lower(email)` does: the login, its lookup and its throttle agree. */
export const normalizeEmail = (email: string): string => email.normalize("NFC").trim().toLowerCase();

// Kysely types the tables of a query by name, and `HubTables` knows none; columns are `snake_case` in the database
const camelCase = new CamelCasePlugin();

/** Gives `db.global`, or a transaction of it, the types of the global tables. */
export const globalTables = (db: Kysely<HubTables>): Kysely<GlobalTables> =>
  db.$extendTables<GlobalTables>().withPlugin(camelCase);
