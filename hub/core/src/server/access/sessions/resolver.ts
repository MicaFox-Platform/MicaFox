import { cookieSettings, readSessionToken, SESSION_MAX_AGE_MS } from "./cookie.js";
import type { SessionDependencies } from "./dependencies.js";
import { deleteSessionsOlderThan, findSession, touchSession } from "./queries.js";
import type { SessionRecord } from "./queries.js";
import { HttpProblem } from "../../app/index.js";
import type { Database } from "../../db/index.js";
import type { ActorResolver } from "../authorization/index.js";
import { globalTables } from "../global-tables/index.js";
import { hashToken } from "../tokens/index.js";

const IDLE_LIMIT_MS = 7 * 24 * 60 * 60_000;
const WRITE_LAST_USE_EVERY_MS = 60_000;

const isExpired = (session: SessionRecord, time: number): boolean =>
  time - session.lastUsedAt.getTime() > IDLE_LIMIT_MS || time - session.createdAt.getTime() > SESSION_MAX_AGE_MS;

/** Deletes the sessions the resolver would refuse as expired; returns how many. A core job runs it every hour. */
export const deleteExpiredSessions = async (db: Database, now: number): Promise<number> =>
  await deleteSessionsOlderThan(globalTables(db.global), {
    lastUsedBefore: new Date(now - IDLE_LIMIT_MS),
    createdBefore: new Date(now - SESSION_MAX_AGE_MS),
  });

/**
 * Finds the actor of a request by its session cookie: 401 `unauthenticated` for no cookie or one the hub does not
 * know, 401 `session-expired` for one past its 7 idle or 30 total days. A removed member is out at their next
 * request, since the memberships are read each time.
 */
export const createSessionResolver =
  (deps: Pick<SessionDependencies, "db" | "publicUrl" | "now">): ActorResolver =>
  async (request) => {
    const token = readSessionToken(request, cookieSettings(deps.publicUrl()));
    if (token === undefined) {
      return undefined;
    }
    const db = globalTables(deps.db.global);
    const tokenHash = hashToken(token);
    const session = await findSession(db, tokenHash);
    if (session === undefined) {
      return undefined;
    }
    const time = deps.now();
    if (isExpired(session, time)) {
      throw new HttpProblem("session-expired");
    }
    await touchSession(db, tokenHash, { at: time, minAgeMs: WRITE_LAST_USE_EVERY_MS });
    return { userId: session.userId, memberships: session.memberships };
  };
