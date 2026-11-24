import type { Kysely } from "kysely";

import type { Membership, Role } from "../authorization/index.js";
import { normalizeEmail } from "../global-tables/index.js";
import type { GlobalTables } from "../global-tables/index.js";
import { createToken, hashToken } from "../tokens/index.js";

type Db = Kysely<GlobalTables>;

/** A session as the resolver needs it: whose it is, when it began and was last used, and their organizations. */
export interface SessionRecord {
  userId: string;
  createdAt: Date;
  lastUsedAt: Date;
  memberships: Membership[];
}

/** A user to check a password against. */
export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
}

/** What `GET /api/v1/session` answers. */
export interface SessionBody {
  user: { id: string; name: string; email: string };
  memberships: Array<{ orgId: string; orgName: string; role: Role }>;
}

/** The session of the token with this hash, with the user's memberships in the order they joined; one query. */
export const findSession = async (db: Db, tokenHash: string): Promise<SessionRecord | undefined> => {
  const rows = await db
    .selectFrom("sessions as s")
    .leftJoin("memberships as m", "m.userId", "s.userId")
    .select(["s.userId", "s.createdAt", "s.lastUsedAt", "m.orgId", "m.role"])
    .where("s.tokenHash", "=", tokenHash)
    .orderBy("m.createdAt")
    .orderBy("m.orgId")
    .execute();
  const first = rows[0];
  if (first === undefined) {
    return undefined;
  }
  const memberships = rows.flatMap((row) =>
    row.orgId === null || row.role === null ? [] : [{ orgId: row.orgId, role: row.role }],
  );
  return { userId: first.userId, createdAt: first.createdAt, lastUsedAt: first.lastUsedAt, memberships };
};

/** Starts a session for `userId` and returns the token for its cookie; only its hash is stored. */
export const insertSession = async (db: Db, userId: string): Promise<string> => {
  const token = createToken();
  await db
    .insertInto("sessions")
    .values({ tokenHash: hashToken(token), userId })
    .execute();
  return token;
};

/** Writes the last use, unless it was written less than `minAgeMs` ago, so a busy session costs one write a minute. */
export const touchSession = async (db: Db, tokenHash: string, use: { at: number; minAgeMs: number }): Promise<void> => {
  await db
    .updateTable("sessions")
    .set({ lastUsedAt: new Date(use.at) })
    .where("tokenHash", "=", tokenHash)
    .where("lastUsedAt", "<=", new Date(use.at - use.minAgeMs))
    .execute();
};

/** Ends one session. */
export const deleteSession = async (db: Db, tokenHash: string): Promise<void> => {
  await db.deleteFrom("sessions").where("tokenHash", "=", tokenHash).execute();
};

/** Deletes the sessions last used before `lastUsedBefore` or begun before `createdBefore`; returns how many. */
export const deleteSessionsOlderThan = async (
  db: Db,
  limits: { lastUsedBefore: Date; createdBefore: Date },
): Promise<number> => {
  const result = await db
    .deleteFrom("sessions")
    .where((where) =>
      where.or([where("lastUsedAt", "<", limits.lastUsedBefore), where("createdAt", "<", limits.createdBefore)]),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
};

/** Ends the user's sessions, except the one with `keepTokenHash`. */
export const deleteSessionsOf = async (db: Db, userId: string, keepTokenHash?: string): Promise<void> => {
  let query = db.deleteFrom("sessions").where("userId", "=", userId);
  if (keepTokenHash !== undefined) {
    query = query.where("tokenHash", "<>", keepTokenHash);
  }
  await query.execute();
};

/** The user with this email, whatever its case. */
export const findUserByEmail = async (db: Db, email: string): Promise<UserRecord | undefined> =>
  await db
    .selectFrom("users")
    .select(["id", "name", "email", "passwordHash"])
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", normalizeEmail(email)))
    .executeTakeFirst();

/** The user with this id. */
export const findUserById = async (db: Db, id: string): Promise<UserRecord | undefined> =>
  await db.selectFrom("users").select(["id", "name", "email", "passwordHash"]).where("id", "=", id).executeTakeFirst();

/** Replaces the user's password hash. */
export const setPasswordHash = async (db: Db, userId: string, passwordHash: string): Promise<void> => {
  await db.updateTable("users").set({ passwordHash }).where("id", "=", userId).execute();
};

/** The user and their organizations as the API shows them, or `undefined` when there is no such user. */
export const describeUser = async (db: Db, userId: string): Promise<SessionBody | undefined> => {
  const user = await db.selectFrom("users").select(["id", "name", "email"]).where("id", "=", userId).executeTakeFirst();
  if (user === undefined) {
    return undefined;
  }
  const memberships = await db
    .selectFrom("memberships as m")
    .innerJoin("orgs as o", "o.id", "m.orgId")
    .select(["m.orgId", "o.name as orgName", "m.role"])
    .where("m.userId", "=", userId)
    .orderBy("m.createdAt")
    .orderBy("m.orgId")
    .execute();
  return { user, memberships };
};
