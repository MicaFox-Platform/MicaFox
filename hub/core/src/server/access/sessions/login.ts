import type { FastifyBaseLogger } from "fastify";

import type { SessionDependencies } from "./dependencies.js";
import { findUserByEmail, setPasswordHash } from "./queries.js";
import type { UserRecord } from "./queries.js";
import { HttpProblem } from "../../app/index.js";
import { globalTables } from "../global-tables/index.js";

/** Who tries to log in, and the log line of the request they do it in. */
export interface LoginAttempt {
  ip: string;
  email: string;
  password: string;
  log: FastifyBaseLogger;
}

/** 429 `rate-limited` with `Retry-After` while the email waits after too many failures; the IP's limit is the route's. */
export const refuseWhenThrottled = (deps: Pick<SessionDependencies, "emailBackoff">, email: string): void => {
  const waitSeconds = deps.emailBackoff.waitFor(email);
  if (waitSeconds !== undefined) {
    throw new HttpProblem("rate-limited", {}, waitSeconds);
  }
};

/**
 * Checks an email and password. An unknown email spends the same scrypt time and gets the same 401 as a wrong
 * password, so the answer never says which emails have an account; a hash with weaker parameters is replaced.
 */
export const authenticate = async (deps: SessionDependencies, attempt: LoginAttempt): Promise<UserRecord> => {
  const { ip, email, password, log } = attempt;
  refuseWhenThrottled(deps, email);
  // Counted as a failure before the check and cleared on success: parallel guesses must not all pass the throttle
  // while the first ones wait for scrypt
  deps.emailBackoff.recordFailure(email);
  const db = globalTables(deps.db.global);
  const user = await findUserByEmail(db, email);
  const check = await deps.passwords.check(password, user?.passwordHash);
  if (user === undefined || !check.matches) {
    log.info({ event: "auth.login-failed", ip, userId: user?.id }, "A login failed");
    throw new HttpProblem("invalid-credentials");
  }
  deps.emailBackoff.recordSuccess(email);
  if (check.needsRehash) {
    await setPasswordHash(db, user.id, await deps.passwords.hash(password));
  }
  log.info({ event: "auth.login", ip, userId: user.id }, "A user logged in");
  return user;
};
