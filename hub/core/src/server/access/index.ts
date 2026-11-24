import { createCan } from "./authorization/index.js";
import type { ActorResolver } from "./authorization/index.js";
import { addTenancyRoutes } from "./tenancy/index.js";
import { HttpProblem } from "../app/index.js";
import type { HubApp } from "../app/index.js";
import type { Database } from "../db/index.js";

export type { Actor, ActorResolver } from "./authorization/index.js";

/** What access needs from the hub. */
export interface AccessOptions {
  db: Database;
  /** Finds the actor of a request; the hub's default finds nobody until sessions exist. */
  resolveActor: ActorResolver;
  /** The features the hub runs: their `<feature>.<action>` are every member's. */
  features: readonly string[];
}

/** The actor nobody is: every route that needs one answers 401 `unauthenticated`. */
export const resolveNobody: ActorResolver = async () => {
  await Promise.resolve(undefined);
};

/**
 * Gives the requests of the app their actor, and adds the routes that depend on it. They come in a plugin so the
 * hook covers them alone: `/healthz`, `/readyz` and the OpenAPI document need no actor. Without an actor a request is
 * 401 before its schema is checked, so a caller who is not logged in learns nothing from a 400.
 */
export const addAccess = (app: HubApp, options: AccessOptions): void => {
  const authorization = { db: options.db, can: createCan(options.features) };
  void app.register((scope: HubApp, _options, done) => {
    scope.decorateRequest("actor");
    scope.addHook("onRequest", async (request) => {
      const actor = await options.resolveActor(request);
      if (actor === undefined) {
        throw new HttpProblem("unauthenticated");
      }
      request.actor = actor;
    });
    addTenancyRoutes(scope, authorization);
    done();
  });
};
