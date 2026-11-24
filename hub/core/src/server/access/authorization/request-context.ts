import type { FastifyRequest } from "fastify";
import type { Transaction } from "kysely";

import type { Actor, Can, Membership } from "./can.js";
import { HttpProblem } from "../../app/index.js";
import type { Database, HubTables } from "../../db/index.js";

/**
 * Finds who makes a request: the user and their memberships, or `undefined` for nobody. The hub's sessions supply
 * the real one; tests give their own.
 */
export type ActorResolver = (request: FastifyRequest) => Promise<Actor | undefined>;

declare module "fastify" {
  interface FastifyRequest {
    /** Who the request comes from; the access plugin answers 401 before a route runs without one. */
    actor: Actor;
  }
}

/** What the routes of access are given: the database and `can()` of the features the hub runs. */
export interface Authorization {
  db: Database;
  can: Can;
}

/** What a route under an organization gets: the actor, their membership there and the organization's database. */
export interface OrgContext {
  actor: Actor;
  membership: Membership;
  /** `db.forOrg` of this organization. */
  forOrg: <T>(run: (db: Transaction<HubTables>) => Promise<T>) => Promise<T>;
  /** `can()` of the actor in this organization. */
  may: (action: string) => boolean;
}

const contextOf = (authorization: Authorization, actor: Actor, membership: Membership): OrgContext => ({
  actor,
  membership,
  forOrg: async (run) => await authorization.db.forOrg(membership.orgId, run),
  may: (action) => authorization.can(actor, action, { orgId: membership.orgId }),
});

/** The context of organization `orgId`; 404 for a non-member, so nothing says the organization exists. */
export const inOrganization = (request: FastifyRequest, authorization: Authorization, orgId: string): OrgContext => {
  const membership = request.actor.memberships.find((candidate) => candidate.orgId === orgId);
  if (membership === undefined) {
    throw new HttpProblem("not-found");
  }
  return contextOf(authorization, request.actor, membership);
};

/** 403 `forbidden` unless the actor may do `action` in the organization of `context`. */
export const requireCan = (context: OrgContext, action: string): void => {
  if (!context.may(action)) {
    throw new HttpProblem("forbidden");
  }
};

/**
 * Runs `run` in the first organization of the actor that holds what it looks for, which it says by returning
 * something other than `undefined`; 404 when none does. A path with only an id has no organization, so each of the
 * actor's organizations is tried through `db.forOrg`, in order: O(organizations), and an actor belongs to a few.
 */
export const inOwningOrg = async <T>(
  request: FastifyRequest,
  authorization: Authorization,
  run: (db: Transaction<HubTables>, context: OrgContext) => Promise<T | undefined>,
): Promise<T> => {
  for (const membership of request.actor.memberships) {
    const context = contextOf(authorization, request.actor, membership);
    const found = await context.forOrg(async (trx) => await run(trx, context));
    if (found !== undefined) {
      return found;
    }
  }
  throw new HttpProblem("not-found");
};
