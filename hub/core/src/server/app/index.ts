import fastify, { LogController } from "fastify";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { createFrameworkErrorHandler } from "./framework-errors.js";
import type { HubApp, TypeBoxTypeProvider } from "./hub-app.js";
import { addOpenApi } from "./openapi.js";
import { handleError, sendProblem } from "./problem/index.js";
import { addRequestLog } from "./request-log.js";
import { createResponseHeaders } from "./response-headers.js";

export { HttpProblem, sendProblem } from "./problem/index.js";
export type { ProblemName } from "./problem/index.js";
export type { HubApp } from "./hub-app.js";

/** What the app takes from the settings and the build. */
export interface AppOptions {
  logger: Logger;
  trustProxy: boolean | number | string[];
  /** Missing in test mode until the port is bound, which is always plain HTTP on localhost. */
  publicUrl: string | undefined;
  /** The hub's version, shown in the OpenAPI document. */
  version: string;
}

// The largest request body; a bigger one is 413 `payload-too-large`: docs/api/hub/http.md
const MAX_BODY_BYTES = 1024 * 1024;

// Fastify accepts a hop count at run time but its types do not; this is what proxy-addr does for a number
const toFastifyTrustProxy = (
  setting: AppOptions["trustProxy"],
): boolean | string[] | ((address: string, hop: number) => boolean) =>
  typeof setting === "number" ? (_address, hop) => hop < setting : setting;

/**
 * Creates the Fastify app with the HTTP API conventions of server.md#serving-a-request. Hooks and handlers go on
 * the root instance directly, so they apply to every route, the 404 and the readiness gate; routes come later, in
 * plugins.
 */
export const createApp = (options: AppOptions): HubApp => {
  const setResponseHeaders = createResponseHeaders(options.publicUrl);
  const app = fastify({
    loggerInstance: options.logger,
    trustProxy: toFastifyTrustProxy(options.trustProxy),
    // The request log line has its own fields and skips the probes: server.md#logging
    logController: new LogController({ disableRequestLogging: true }),
    // The hub answers while stopping itself, so /healthz stays 200 and the 503 is a problem document
    return503OnClosing: false,
    forceCloseConnections: "idle",
    bodyLimit: MAX_BODY_BYTES,
    // A client's own `x-request-id` is ignored: an id it chose could collide with another request's in the logs
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // A malformed URL fails before routing; without this Fastify answers it with its own JSON and no headers
    frameworkErrors: createFrameworkErrorHandler(setResponseHeaders),
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook("onSend", async (request, reply, payload) => {
    setResponseHeaders(request, reply);
    return payload;
  });
  addRequestLog(app);
  app.setErrorHandler(handleError);
  app.setNotFoundHandler((_request, reply) => sendProblem(reply, "not-found"));
  addOpenApi(app, options.version);
  return app;
};
