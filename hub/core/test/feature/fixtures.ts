import { sql } from "kysely";
import { Type } from "typebox";

import { defineExtension, defineFeature } from "../../src/server/feature/index.js";
import type { ExtensionFeature, Feature, FeatureRoutes, ProtocolModule } from "../../src/server/feature/index.js";

/** A feature with no routes, as the hub tests need to name features the hub runs. */
export const emptyFeature = (name: string, overrides: Partial<Feature> = {}): Feature =>
  defineFeature({ name, server: () => undefined, ...overrides });

const params = Type.Object({ orgId: Type.String() });
const projectParams = Type.Object({ projectId: Type.String() });
const orgQuery = Type.Object({ org: Type.String() });
const nameBody = Type.Object({ name: Type.String({ minLength: 1 }) });

/**
 * Routes that reach an organization the ways a feature can: `orgId` in the path, with and without a helper of the
 * core, an organization named in the query, and an id only, found through `inOwningOrg`.
 */
export const pingRoutes: FeatureRoutes = (app, access) => {
  app.get("/orgs/:orgId/ping", { schema: { params } }, async (request) => {
    const context = await access.inOrganization(request, request.params.orgId);
    return { pong: context.membership.orgId };
  });
  // Never asks the core who may enter: only the gate in front of an extension's routes stops a caller here
  app.get("/orgs/:orgId/bare", { schema: { params } }, () => ({ pong: true }));
  app.post("/orgs/:orgId/bare", { schema: { params, body: nameBody } }, () => ({ pong: true }));
  // Copies a project in the organization that holds it: work that a refusal must roll back
  app.post("/projects/:projectId/copies", { schema: { params: projectParams, body: nameBody } }, async (request) => {
    return await access.inOwningOrg(request, async (trx, context) => {
      const { rows } = await sql<{ id: string }>`insert into projects (org_id, name)
        select org_id, ${request.body.name} from projects where id = ${request.params.projectId}
        returning id`.execute(trx);
      return rows[0] === undefined ? undefined : { pong: context.membership.orgId };
    });
  });
  app.get("/by-query", { schema: { querystring: orgQuery } }, async (request) => {
    const context = await access.inOrganization(request, request.query.org);
    return { pong: context.membership.orgId };
  });
  app.get("/projects/:projectId", { schema: { params: projectParams } }, async (request) => {
    return await access.inOwningOrg(request, async (trx) => {
      const { rows } = await sql<{
        id: string;
      }>`select id from projects where id = ${request.params.projectId}`.execute(trx);
      return rows[0] === undefined ? undefined : { pong: rows[0].id };
    });
  });
};

/** A core feature that answers the `ping` routes under `/api/v1/<name>`. */
export const pingFeature = (name: string, overrides: Partial<Feature> = {}): Feature =>
  defineFeature({ name, server: pingRoutes, ...overrides });

/** An extension feature with the `ping` routes; its entitlement is `<name>-plan`. */
export const paidFeature = (name: string, overrides: Partial<ExtensionFeature> = {}): ExtensionFeature =>
  defineFeature({ name, entitlement: `${name}-plan`, server: pingRoutes, ...overrides });

/** An extension with one paid feature and no entitlement source, as S2 ships it. */
export const fixtureExtension = (
  feature: ExtensionFeature = paidFeature("fixture"),
): ReturnType<typeof defineExtension> => defineExtension({ features: [feature] });

/** The SDK module of a feature that keeps no state and ignores every message. */
export const protocolModule = (module: string): ProtocolModule => ({
  module,
  state: async () => await Promise.resolve([]),
  onMessage: async () => {
    await Promise.resolve();
  },
});
