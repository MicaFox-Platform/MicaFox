import { createCan } from "./authorization/index.js";
import type { ActorResolver } from "./authorization/index.js";
import { createPasswordHasher } from "./password/index.js";
import { addLoginRoute, addOriginCheck, addSessionRoutes, createSessionResolver } from "./sessions/index.js";
import type { SessionDependencies } from "./sessions/index.js";
import { addSetupRoute } from "./setup/index.js";
import { addTenancyRoutes } from "./tenancy/index.js";
import { addPerIpLimit, createEmailBackoff } from "./throttle/index.js";
import { HttpProblem } from "../app/index.js";
import type { HubApp } from "../app/index.js";
import type { Database } from "../db/index.js";

export type { Actor, ActorResolver } from "./authorization/index.js";
export { ensureSetupToken } from "./setup/index.js";
export type { SetupTokenOptions } from "./setup/index.js";

/** What access needs from the hub. */
export interface AccessOptions {
  db: Database;
  /** Finds the actor of a request; the hub's own reads the session cookie, and tests give theirs. */
  resolveActor?: ActorResolver;
  /** The features the hub runs: their `<feature>.<action>` are every member's. */
  features: readonly string[];
  /** The URL users open, asked at each request: in test mode it is known only once the port is bound. */
  publicUrl: () => string;
  /** The clock in milliseconds; `Date.now` by default. */
  now?: () => number;
}

/**
 * Adds the routes of access. The origin check covers all of them; the setup and the login are open to a caller
 * who is not logged in, and every other route gets its actor first: without one a request is 401 before its schema
 * is checked, so a caller who is not logged in learns nothing from a 400. They come in plugins so the hooks cover
 * them alone: `/healthz`, `/readyz` and the OpenAPI document need no actor.
 */
export const addAccess = (app: HubApp, options: AccessOptions): void => {
  const now = options.now ?? Date.now;
  const deps: SessionDependencies = {
    db: options.db,
    passwords: createPasswordHasher(),
    emailBackoff: createEmailBackoff(now),
    publicUrl: options.publicUrl,
    now,
  };
  const resolveActor = options.resolveActor ?? createSessionResolver(deps);
  const authorization = { db: options.db, can: createCan(options.features) };

  void app.register((scope: HubApp, _options, done) => {
    addPerIpLimit(scope);
    addOriginCheck(scope, deps);
    void scope.register((open: HubApp, _openOptions, openDone) => {
      addSetupRoute(open, deps);
      addLoginRoute(open, deps);
      openDone();
    });
    void scope.register((actorScope: HubApp, _actorOptions, actorDone) => {
      actorScope.decorateRequest("actor");
      actorScope.addHook("onRequest", async (request) => {
        const actor = await resolveActor(request);
        if (actor === undefined) {
          throw new HttpProblem("unauthenticated");
        }
        request.actor = actor;
      });
      addSessionRoutes(actorScope, deps);
      addTenancyRoutes(actorScope, authorization);
      actorDone();
    });
    done();
  });
};
