import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

import { handleError } from "./problem/index.js";
import { logRequest } from "./request-log.js";
import type { SetResponseHeaders } from "./response-headers.js";

/** Answers an error Fastify raises before routing. */
export type FrameworkErrorHandler = (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => void;

/**
 * Creates the handler of errors Fastify raises before routing, such as a malformed URL. Their requests have none
 * of the app's hooks, so it sets the headers and logs the request itself; it is answered at once, hence no duration.
 */
export const createFrameworkErrorHandler =
  (setResponseHeaders: SetResponseHeaders): FrameworkErrorHandler =>
  (error, request, reply) => {
    setResponseHeaders(request, reply);
    void handleError(error, request, reply);
    logRequest(request, reply.statusCode, 0);
  };
