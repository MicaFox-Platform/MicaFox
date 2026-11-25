import { createCan } from "./authorization/index.js";
import type { ActorResolver, Authorization } from "./authorization/index.js";
import { addEntitlementRoutes } from "./entitlements/index.js";
import type { Entitlements } from "./entitlements/index.js";
import { addKeyRoutes, createKeyLookup, createRevokeHooks } from "./keys/index.js";
import type { KeyRevokedListener, KeyScope } from "./keys/index.js";
import { createPasswordHasher } from "./password/index.js";
import { addLoginRoute, addOriginCheck, addSessionRoutes, createSessionResolver } from "./sessions/index.js";
import type { SessionDependencies } from "./sessions/index.js";
import { addSetupRoute } from "./setup/index.js";
import { addTenancyRoutes } from "./tenancy/index.js";
import { addPerIpLimit, createEmailBackoff } from "./throttle/index.js";
import { HttpProblem } from "../app/index.js";
import type { HubApp } from "../app/index.js";
import type { Database } from "../db/index.js";
import { addEventsRoute } from "../events/index.js";
import type { Events } from "../events/index.js";

export { inOrganization, inOwningOrg, requireCan } from "./authorization/index.js";
export type { Actor, ActorResolver, Authorization, OrgContext } from "./authorization/index.js";
export { createEntitlements } from "./entitlements/index.js";
export type { EntitlementSource, Entitlements, OrgEntitlements } from "./entitlements/index.js";
export type { KeyRevokedListener, KeyScope } from "./keys/index.js";
export { deleteExpiredSessions } from "./sessions/index.js";
export { ensureSetupToken } from "./setup/index.js";
export type { SetupTokenOptions } from "./setup/index.js";
export { listOrgIds } from "./tenancy/index.js";

/** What access needs from the hub. */
export interface AccessOptions {
  db: Database;
  /** The bus the routes publish to once a change commits, and the streams that logging out everywhere ends. */
  events: Events;
  /** Finds the actor of a request; the hub's own reads the session cookie, and tests give theirs. */
  resolveActor?: ActorResolver;
  /** The names of the features the hub runs: their `<feature>.<action>` are every member's. */
  features: readonly string[];
  entitlements: Entitlements;
  /** Adds the features' routes inside the scope that has the actor, after the core's. */
  addFeatureRoutes?: (scope: HubApp, authorization: Authorization) => void;
  /** The URL users open, asked at each request: in test mode it is known only once the port is bound. */
  publicUrl: () => string;
  /** The clock in milliseconds; `Date.now` by default. */
  now?: () => number;
}

/** What the rest of the hub uses of access. */
export interface Access {
  /** Finds the active project key `token` is, by its hash only; a revoked or unknown token gives `undefined`. */
  lookupKey: (token: string) => Promise<KeyScope | undefined>;
  /** Runs `listener` after each key revoke commits, as the SDK endpoint closes the key's sessions. */
  onKeyRevoked: (listener: KeyRevokedListener) => void;
}

/**
 * Adds the routes of access. The origin check covers all of them; the setup and the login are open to a caller
 * who is not logged in, and every other route gets its actor first: without one a request is 401 before its schema
 * is checked, so a caller who is not logged in learns nothing from a 400. They come in plugins so the hooks cover
 * them alone: `/healthz`, `/readyz` and the OpenAPI document need no actor.
 */
export const addAccess = (app: HubApp, options: AccessOptions): Access => {
  const now = options.now ?? Date.now;
  const deps: SessionDependencies = {
    db: options.db,
    passwords: createPasswordHasher(),
    emailBackoff: createEmailBackoff(now),
    publicUrl: options.publicUrl,
    streams: options.events.streams,
    now,
  };
  const resolveActor = options.resolveActor ?? createSessionResolver(deps);
  const authorization = { db: options.db, can: createCan(options.features) };
  const keyHooks = createRevokeHooks();

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
      addEventsRoute(actorScope, options.events.streams);
      addTenancyRoutes(actorScope, authorization, options.events.bus);
      addKeyRoutes(actorScope, {
        authorization,
        publicUrl: options.publicUrl,
        hooks: keyHooks,
        bus: options.events.bus,
      });
      addEntitlementRoutes(actorScope, authorization, options.entitlements);
      options.addFeatureRoutes?.(actorScope, authorization);
      actorDone();
    });
    done();
  });
  return { lookupKey: createKeyLookup(options.db), onKeyRevoked: keyHooks.add };
};
