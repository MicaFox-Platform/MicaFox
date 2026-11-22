import { Type } from "typebox";
import { describe, expectTypeOf, it } from "vitest";

import type { HubApp } from "../index.js";

// Features and core parts declare routes on a HubApp: their handlers see the types of their schemas
declare const app: HubApp;

describe("HubApp", () => {
  it("types a route's params, query and body from its TypeBox schemas", () => {
    app.post(
      "/api/v1/orgs/:orgId/projects",
      {
        schema: {
          params: Type.Object({ orgId: Type.String() }),
          querystring: Type.Object({ dryRun: Type.Optional(Type.Boolean()) }),
          body: Type.Object({ name: Type.String() }),
        },
      },
      (request) => {
        expectTypeOf(request.params).toEqualTypeOf<{ orgId: string }>();
        expectTypeOf(request.query).toEqualTypeOf<{ dryRun?: boolean }>();
        expectTypeOf(request.body).toEqualTypeOf<{ name: string }>();
        return { id: "p1" };
      },
    );
  });
});
