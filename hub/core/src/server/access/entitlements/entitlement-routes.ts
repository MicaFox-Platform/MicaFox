import { Type } from "typebox";

import type { Entitlements } from "./entitlements.js";
import type { HubApp } from "../../app/index.js";
import { inOrganization, requireCan } from "../authorization/index.js";
import type { Authorization } from "../authorization/index.js";
import { orgParams } from "../tenancy/index.js";

const entitlementsReply = Type.Object({ entitlements: Type.Array(Type.String()) });

/** `GET /api/v1/orgs/{orgId}/entitlements`: what the web app shows or hides; the server gates each part itself. */
export const addEntitlementRoutes = (app: HubApp, authorization: Authorization, entitlements: Entitlements): void => {
  app.get(
    "/api/v1/orgs/:orgId/entitlements",
    { schema: { params: orgParams, response: { 200: entitlementsReply } } },
    async (request) => {
      const context = inOrganization(request, authorization, request.params.orgId);
      requireCan(context, "entitlement.read");
      return { entitlements: [...(await entitlements(context.membership.orgId).list())] };
    },
  );
};
