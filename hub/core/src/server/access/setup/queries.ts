import type { Kysely } from "kysely";

import type { GlobalTables } from "../global-tables/index.js";

type Db = Kysely<GlobalTables>;

/** What the first owner is made from. */
export interface FirstOwner {
  orgName: string;
  name: string;
  email: string;
  passwordHash: string;
}

/** Whether any organization has an owner: from then on the hub is claimed. */
export const hasOwner = async (db: Db): Promise<boolean> =>
  (await db.selectFrom("memberships").select("userId").where("role", "=", "owner").limit(1).executeTakeFirst()) !==
  undefined;

/** Makes `tokenHash` the one setup token, dropping the one an earlier start left. */
export const replaceSetupToken = async (db: Db, tokenHash: string): Promise<void> => {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("credentials").where("kind", "=", "setup").execute();
    await trx.insertInto("credentials").values({ kind: "setup", tokenHash }).execute();
  });
};

/** Whether the hub holds the setup token with this hash. */
export const isSetupToken = async (db: Db, tokenHash: string): Promise<boolean> =>
  (await db
    .selectFrom("credentials")
    .select("id")
    .where("kind", "=", "setup")
    .where("tokenHash", "=", tokenHash)
    .executeTakeFirst()) !== undefined;

/**
 * Spends the setup token and creates the organization, its owner and the membership, in the caller's transaction.
 * Deleting the token is what decides a race between two requests with the right token: only one gets a row back, the
 * other gets `undefined`.
 */
export const claimHub = async (
  trx: Db,
  tokenHash: string,
  owner: FirstOwner,
): Promise<{ userId: string; orgId: string } | undefined> => {
  const spent = await trx
    .deleteFrom("credentials")
    .where("kind", "=", "setup")
    .where("tokenHash", "=", tokenHash)
    .returning("id")
    .executeTakeFirst();
  if (spent === undefined) {
    return undefined;
  }
  const org = await trx.insertInto("orgs").values({ name: owner.orgName }).returning("id").executeTakeFirstOrThrow();
  const user = await trx
    .insertInto("users")
    .values({ email: owner.email, name: owner.name, passwordHash: owner.passwordHash })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx.insertInto("memberships").values({ userId: user.id, orgId: org.id, role: "owner" }).execute();
  return { userId: user.id, orgId: org.id };
};
