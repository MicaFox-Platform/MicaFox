import swagger from "@fastify/swagger";

import type { HubApp } from "./hub-app.js";

// Only the public API is described; `/api/internal` serves the web app alone and may change at any time (ADR 0031)
const PUBLIC_PREFIX = "/api/v1/";

/**
 * Serves `GET /api/v1/openapi.json`, built from the routes' TypeBox schemas. `@fastify/swagger` sees a route when it
 * is added, so routes come in plugins registered after the app is created, as features do; the document is built
 * on the first request and cached by the plugin.
 */
export const addOpenApi = (app: HubApp, version: string): void => {
  void app.register(swagger, {
    openapi: { openapi: "3.1.0", info: { title: "MicaFox Hub", version } },
    transform: ({ schema, url }) => ({
      schema: url.startsWith(PUBLIC_PREFIX) ? schema : { ...schema, hide: true },
      url,
    }),
  });
  void app.register((scope, _options, done) => {
    scope.get("/api/v1/openapi.json", () => scope.swagger());
    done();
  });
};
