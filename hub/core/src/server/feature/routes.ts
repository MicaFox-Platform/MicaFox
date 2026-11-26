import type { FastifyRequest } from "fastify";

import type { Feature, FeatureAccess, FeatureRoutes, SdkApi } from "./contract.js";
import type { Gate } from "./gate.js";
import type { FeatureRegistry } from "./registry.js";
import { inOrganization, inOwningOrg, requireCan } from "../access/index.js";
import type { Authorization } from "../access/index.js";
import { HttpProblem } from "../app/index.js";
import type { HubApp } from "../app/index.js";

/** What the routes of the features need from the hub. */
export interface FeatureRoutesOptions {
  registry: FeatureRegistry;
  authorization: Authorization;
  gate: Gate;
  sdk: SdkApi;
}

// 403 `entitlement-required` when the organization lacks the feature's entitlement; core features never get here
const requireEntitled = async (gate: Gate, orgId: string, feature: string): Promise<void> => {
  if (!(await gate.isEntitled(orgId, feature))) {
    throw new HttpProblem("entitlement-required");
  }
};

// The actor's organizations that have the feature's entitlement; an actor belongs to a few
const entitledOrgs = async (gate: Gate, request: FastifyRequest, feature: string): Promise<ReadonlySet<string>> => {
  const orgIds = request.actor.memberships.map((membership) => membership.orgId);
  const answers = await Promise.all(orgIds.map(async (orgId) => await gate.isEntitled(orgId, feature)));
  return new Set(orgIds.filter((_orgId, index) => answers[index]));
};

// What a feature's routes call: the core's own helpers, with the gate inside for a feature of the extension
const createAccess = (options: FeatureRoutesOptions, feature: string, isGated: boolean): FeatureAccess => {
  const { authorization, gate } = options;
  return {
    inOrganization: async (request, orgId) => {
      const context = inOrganization(request, authorization, orgId);
      if (isGated) {
        await requireEntitled(gate, orgId, feature);
      }
      return context;
    },
    // The organization is only known once it holds the id, and the work is done by then. So the gate is asked for
    // each of the actor's organizations first, outside any transaction, and a refusal throws inside the
    // organization's transaction, which rolls the work back
    inOwningOrg: async (request, run) => {
      const entitled = isGated ? await entitledOrgs(gate, request, feature) : undefined;
      return await inOwningOrg(request, authorization, async (trx, context) => {
        const found = await run(trx, context);
        if (found !== undefined && entitled?.has(context.membership.orgId) === false) {
          throw new HttpProblem("entitlement-required");
        }
        return found;
      });
    },
    requireCan,
    sdk: options.sdk,
  };
};

const orgIdOf = (request: FastifyRequest): string | undefined => {
  const { params } = request;
  return typeof params === "object" && params !== null && "orgId" in params && typeof params.orgId === "string"
    ? params.orgId
    : undefined;
};

// A route with an organization in its path is refused before its body is read, whatever it then does: a non-member
// is 404 as everywhere, a member of an organization without the entitlement 403. The actor's hook runs before this
// one, in the parent scope
const addGateHook = (scope: HubApp, options: FeatureRoutesOptions, feature: string): void => {
  scope.addHook("onRequest", async (request) => {
    const orgId = orgIdOf(request);
    if (orgId === undefined) {
      return;
    }
    inOrganization(request, options.authorization, orgId);
    await requireEntitled(options.gate, orgId, feature);
  });
};

interface RegisteredFeature {
  feature: Feature;
  isGated: boolean;
}

interface PluginParts {
  routes: FeatureRoutes;
  prefix: string;
  access: FeatureAccess;
  options: FeatureRoutesOptions;
  feature: string;
  isGated: boolean;
}

const addPlugin = (app: HubApp, parts: PluginParts): void => {
  void app.register(
    async (scope: HubApp) => {
      if (parts.isGated) {
        addGateHook(scope, parts.options, parts.feature);
      }
      await parts.routes(scope, parts.access);
    },
    { prefix: parts.prefix },
  );
};

const addFeature = (app: HubApp, options: FeatureRoutesOptions, entry: RegisteredFeature): void => {
  const { feature, isGated } = entry;
  const shared = {
    options,
    feature: feature.name,
    isGated,
    access: createAccess(options, feature.name, isGated),
  };
  addPlugin(app, { ...shared, routes: feature.server, prefix: `/api/v1/${feature.name}` });
  if (feature.internal !== undefined) {
    addPlugin(app, { ...shared, routes: feature.internal, prefix: `/api/internal/${feature.name}` });
  }
};

/**
 * Registers each feature's `server` under `/api/v1/<name>` and `internal` under `/api/internal/<name>`, each in its
 * own encapsulated plugin so a feature's hooks and decorators reach no other. Call it inside the scope that has the
 * actor, so a request is 401 before it reaches a feature.
 */
export const addFeatureRoutes = (app: HubApp, options: FeatureRoutesOptions): void => {
  for (const { feature, entitlement } of options.registry.features) {
    addFeature(app, options, { feature, isGated: entitlement !== undefined });
  }
};
