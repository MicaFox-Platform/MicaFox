import type { FastifyRequest } from "fastify";

import { clearSessionCookie, cookieSettings, readSessionToken, setSessionCookie } from "./cookie.js";
import type { SessionDependencies } from "./dependencies.js";
import { authenticate, refuseWhenThrottled } from "./login.js";
import {
  deleteSession,
  deleteSessionsOf,
  describeUser,
  findUserById,
  insertSession,
  setPasswordHash,
} from "./queries.js";
import type { SessionBody } from "./queries.js";
import { loginBody, noContent, passwordBody, sessionReply } from "./schemas.js";
import { HttpProblem } from "../../app/index.js";
import type { HubApp } from "../../app/index.js";
import { globalTables } from "../global-tables/index.js";
import { PER_IP_LIMIT } from "../throttle/index.js";
import { hashToken } from "../tokens/index.js";

// A session whose user is gone, such as a test's actor, has nothing to show: it is as good as logged out
export const requireUser = async (deps: SessionDependencies, userId: string): Promise<SessionBody> => {
  const body = await describeUser(globalTables(deps.db.global), userId);
  if (body === undefined) {
    throw new HttpProblem("unauthenticated");
  }
  return body;
};

// The hash of the session the request came with, if any
const currentTokenHash = (deps: SessionDependencies, request: FastifyRequest): string | undefined => {
  const token = readSessionToken(request, cookieSettings(deps.publicUrl()));
  return token === undefined ? undefined : hashToken(token);
};

/** `POST /api/v1/session`: logs in. Public, so it comes in a scope without the actor hook. */
export const addLoginRoute = (app: HubApp, deps: SessionDependencies): void => {
  app.post(
    "/api/v1/session",
    { schema: { body: loginBody, response: { 200: sessionReply } }, config: { rateLimit: PER_IP_LIMIT } },
    async (request, reply) => {
      const user = await authenticate(deps, { ...request.body, ip: request.ip, log: request.log });
      const token = await insertSession(globalTables(deps.db.global), user.id);
      setSessionCookie(reply, cookieSettings(deps.publicUrl()), token);
      return await requireUser(deps, user.id);
    },
  );
};

// What changes a password: the current one is checked like a login, and every other session ends
const addPasswordRoute = (app: HubApp, deps: SessionDependencies): void => {
  app.put(
    "/api/v1/me/password",
    { schema: { body: passwordBody, response: { 204: noContent } }, config: { rateLimit: PER_IP_LIMIT } },
    async (request, reply) => {
      const { userId } = request.actor;
      const { currentPassword, newPassword } = request.body;
      const db = globalTables(deps.db.global);
      const user = await findUserById(db, userId);
      if (user === undefined) {
        throw new HttpProblem("unauthenticated");
      }
      refuseWhenThrottled(deps, user.email);
      // A failure until the check says otherwise, as at login
      deps.emailBackoff.recordFailure(user.email);
      const check = await deps.passwords.check(currentPassword, user.passwordHash);
      if (!check.matches) {
        throw new HttpProblem("invalid-credentials");
      }
      deps.emailBackoff.recordSuccess(user.email);
      const passwordHash = await deps.passwords.hash(newPassword);
      await db.transaction().execute(async (trx) => {
        await setPasswordHash(trx, userId, passwordHash);
        await deleteSessionsOf(trx, userId, currentTokenHash(deps, request));
      });
      request.log.info({ event: "auth.password-changed", userId }, "A user changed their password");
      return await reply.code(204).send(null);
    },
  );
};

/** `GET` and `DELETE /api/v1/session`, `DELETE /api/v1/sessions` and `PUT /api/v1/me/password`: for a logged-in actor. */
export const addSessionRoutes = (app: HubApp, deps: SessionDependencies): void => {
  app.get(
    "/api/v1/session",
    { schema: { response: { 200: sessionReply } } },
    async (request) => await requireUser(deps, request.actor.userId),
  );

  app.delete("/api/v1/session", { schema: { response: { 204: noContent } } }, async (request, reply) => {
    const tokenHash = currentTokenHash(deps, request);
    if (tokenHash !== undefined) {
      await deleteSession(globalTables(deps.db.global), tokenHash);
    }
    clearSessionCookie(reply, cookieSettings(deps.publicUrl()));
    request.log.info({ event: "auth.logout", userId: request.actor.userId }, "A user logged out");
    return await reply.code(204).send(null);
  });

  app.delete("/api/v1/sessions", { schema: { response: { 204: noContent } } }, async (request, reply) => {
    await deleteSessionsOf(globalTables(deps.db.global), request.actor.userId);
    deps.streams.endUser(request.actor.userId);
    clearSessionCookie(reply, cookieSettings(deps.publicUrl()));
    request.log.info({ event: "auth.logout-everywhere", userId: request.actor.userId }, "A user logged out everywhere");
    return await reply.code(204).send(null);
  });

  addPasswordRoute(app, deps);
};
