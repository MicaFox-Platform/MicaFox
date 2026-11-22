import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApp } from "../../../../test/server/app.js";
import type { HubApp } from "../index.js";

const apps: HubApp[] = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

// Routes come in plugins, as features and core parts add theirs
const create = (): HubApp => {
  const { app } = createTestApp({ version: "1.2.3" });
  void app.register((scope, _options, done) => {
    scope.get("/healthz", () => ({ status: "ok" }));
    scope.post(
      "/api/v1/orgs/:orgId/projects",
      {
        schema: {
          params: Type.Object({ orgId: Type.String({ format: "uuid" }) }),
          body: Type.Object({ name: Type.String() }),
          response: { 201: Type.Object({ id: Type.String() }) },
        },
      },
      () => ({ id: "p1" }),
    );
    scope.get(
      "/api/internal/web-settings",
      { schema: { response: { 200: Type.Object({ theme: Type.String() }) } } },
      () => ({ theme: "dark" }),
    );
    scope.get("/assets/app.js", () => "");
    done();
  });
  apps.push(app);
  return app;
};

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { requestBody?: unknown }>>;
}

const fetchDocument = async (app: HubApp): Promise<OpenApiDocument> => {
  const response = await app.inject({ url: "/api/v1/openapi.json" });
  return response.json<OpenApiDocument>();
};

describe("GET /api/v1/openapi.json", () => {
  it("describes the hub's version as an OpenAPI 3.1 document", async () => {
    const document = await fetchDocument(create());

    expect(document).toMatchObject({ openapi: "3.1.0", info: { title: "MicaFox Hub", version: "1.2.3" } });
  });

  it("lists exactly the /api/v1 routes, never /api/internal, probes or web files", async () => {
    const document = await fetchDocument(create());

    expect(Object.keys(document.paths).sort()).toEqual(["/api/v1/openapi.json", "/api/v1/orgs/{orgId}/projects"]);
  });

  it("describes a route from its TypeBox schemas", async () => {
    const document = await fetchDocument(create());

    expect(document.paths["/api/v1/orgs/{orgId}/projects"]?.post?.requestBody).toMatchObject({
      content: { "application/json": { schema: { properties: { name: { type: "string" } }, required: ["name"] } } },
    });
  });
});
