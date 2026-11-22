import type { FastifyError, FastifySchemaValidationError } from "fastify";

import type { ProblemDetails, ProblemName } from "./catalog.js";
import { HttpProblem } from "./http-problem.js";
import { toValidationDetails } from "./validation-errors.js";

/** The problem an error becomes; only `internal` is a bug of the hub, every other one is the client's. */
export interface ErrorAnswer {
  name: ProblemName;
  details?: ProblemDetails;
}

// The client errors Fastify raises with a status of their own; any other 4xx of Fastify's is `validation`
const PROBLEMS_BY_STATUS = new Map<number, ProblemName>([
  [404, "not-found"],
  [413, "payload-too-large"],
]);

// A request body that breaks off mid-stream: Fastify gives the stream's error a 400
const REQUEST_STREAM_CODES = new Set(["ECONNRESET", "ECONNABORTED", "ERR_STREAM_PREMATURE_CLOSE"]);

const INTERNAL: ErrorAnswer = { name: "internal" };

const isValidationError = (error: Error): error is FastifyError & { validation: FastifySchemaValidationError[] } =>
  "validation" in error && Array.isArray(error.validation);

const codeOf = (error: Error): string | undefined =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;

const statusOf = (error: Error): number | undefined =>
  "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;

// A 4xx status counts only on errors Fastify raised about the request; anyone else's, such as an upstream service's
// 401 seen by a route, is a bug of the hub and must not reach the client as its own problem
const isRequestError = (code: string | undefined): code is string =>
  code !== undefined && (code.startsWith("FST_") || REQUEST_STREAM_CODES.has(code));

/** Decides which problem answers `error`: its own, a schema failure, a client error of Fastify's, or `internal`. */
export const classifyError = (error: unknown): ErrorAnswer => {
  if (error instanceof HttpProblem) {
    return { name: error.problem, details: error.details };
  }
  if (!(error instanceof Error)) {
    return INTERNAL;
  }
  if (isValidationError(error)) {
    return { name: "validation", details: toValidationDetails(error.validation, error.validationContext) };
  }
  const status = statusOf(error);
  const code = codeOf(error);
  if (status === undefined || status < 400 || status >= 500 || !isRequestError(code)) {
    return INTERNAL;
  }
  // Fastify's own messages describe the request, never the hub's state, so the client may read them
  const details = code.startsWith("FST_") ? { detail: error.message } : {};
  return { name: PROBLEMS_BY_STATUS.get(status) ?? "validation", details };
};
