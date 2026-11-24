import { Type } from "typebox";

import { claimHub, hasOwner, isSetupToken } from "./queries.js";
import { HttpProblem } from "../../app/index.js";
import type { HubApp } from "../../app/index.js";
import { globalTables } from "../global-tables/index.js";
import { cookieSettings, insertSession, requireUser, sessionReply, setSessionCookie } from "../sessions/index.js";
import type { SessionDependencies } from "../sessions/index.js";
import { normalizeName } from "../tenancy/index.js";
import { PER_IP_LIMIT } from "../throttle/index.js";
import { hashToken } from "../tokens/index.js";

const setupBody = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 256 }),
  orgName: Type.String({ maxLength: 256 }),
  name: Type.String({ maxLength: 256 }),
  email: Type.String({ format: "email", maxLength: 254 }),
  password: Type.String({ minLength: 12, maxLength: 256 }),
});

/**
 * `POST /api/v1/setup`: spends the setup token to create the organization, its owner and a session. Public: it is
 * the one route a hub without an owner answers.
 */
export const addSetupRoute = (app: HubApp, deps: SessionDependencies): void => {
  app.post(
    "/api/v1/setup",
    // The token is guessed at like a password, so the route has the same limit per IP as the login
    { schema: { body: setupBody, response: { 201: sessionReply } }, config: { rateLimit: PER_IP_LIMIT } },
    async (request, reply) => {
      const db = globalTables(deps.db.global);
      if (await hasOwner(db)) {
        throw new HttpProblem("not-found");
      }
      const { body } = request;
      const tokenHash = hashToken(body.token);
      if (!(await isSetupToken(db, tokenHash))) {
        request.log.info({ event: "auth.setup-failed", ip: request.ip }, "A setup was refused: wrong token");
        throw new HttpProblem("forbidden");
      }
      const owner = {
        orgName: normalizeName(body.orgName, "orgName"),
        name: normalizeName(body.name),
        email: body.email.trim(),
        passwordHash: await deps.passwords.hash(body.password),
      };
      const claimed = await db.transaction().execute(async (trx) => {
        const ids = await claimHub(trx, tokenHash, owner);
        return ids === undefined ? undefined : { ...ids, sessionToken: await insertSession(trx, ids.userId) };
      });
      if (claimed === undefined) {
        throw new HttpProblem("forbidden");
      }
      setSessionCookie(reply, cookieSettings(deps.publicUrl()), claimed.sessionToken);
      request.log.info({ event: "auth.setup", userId: claimed.userId, orgId: claimed.orgId }, "The hub was set up");
      return await reply.code(201).send(await requireUser(deps, claimed.userId));
    },
  );
};
