import type { FastifyReply, FastifyRequest } from "fastify";

import { createProblem, PROBLEMS } from "./catalog.js";
import type { ProblemDetails, ProblemName } from "./catalog.js";
import { classifyError } from "./classify-error.js";
import { HttpProblem } from "./http-problem.js";

/** Answers the request with the problem `name`, its status and the request id. */
export const sendProblem = (reply: FastifyReply, name: ProblemName, details?: ProblemDetails): FastifyReply =>
  reply
    .code(PROBLEMS[name].status)
    .type("application/problem+json")
    .send(createProblem(name, reply.request.id, details));

/**
 * The hub's error handler: every error becomes a problem. An unexpected one is logged with its stack and answered
 * without its message, which may hold internal state.
 */
export const handleError = (error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply => {
  const answer = classifyError(error);
  if (answer.name === "internal") {
    request.log.error({ err: error }, "request.failed");
  }
  if (error instanceof HttpProblem && error.retryAfterSeconds !== undefined) {
    void reply.header("retry-after", String(error.retryAfterSeconds));
  }
  return sendProblem(reply, answer.name, answer.details);
};
