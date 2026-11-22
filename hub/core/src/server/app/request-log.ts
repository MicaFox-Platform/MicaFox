import type { FastifyRequest } from "fastify";

import type { HubApp } from "./hub-app.js";

// Probes run every few seconds and would drown the requests that matter: server.md#logging
const UNLOGGED_ROUTES = new Set(["/healthz", "/readyz"]);

// A request that matched no route, such as a 404 or a malformed URL, has no route pattern to log
const routeOf = (request: FastifyRequest): string => request.routeOptions.url ?? "(unmatched)";

/** Logs the one `info` line of a request that got its response; probes are skipped. */
export const logRequest = (request: FastifyRequest, statusCode: number, durationMs: number): void => {
  const route = routeOf(request);
  if (UNLOGGED_ROUTES.has(route)) {
    return;
  }
  request.log.info(
    { method: request.method, route, statusCode, durationMs: Math.round(durationMs) },
    "request.completed",
  );
};

/** Logs every request routed by the app, after its response or when the client gives up on it. */
export const addRequestLog = (app: HubApp): void => {
  app.addHook("onResponse", (request, reply, done) => {
    logRequest(request, reply.statusCode, reply.elapsedTime);
    done();
  });

  // The response never finishes for an aborted request, so `onResponse` does not run
  app.addHook("onRequestAbort", (request, done) => {
    const route = routeOf(request);
    if (!UNLOGGED_ROUTES.has(route)) {
      request.log.info({ method: request.method, route }, "request.aborted");
    }
    done();
  });
};
