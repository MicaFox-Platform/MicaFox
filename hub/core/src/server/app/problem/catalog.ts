/**
 * Every problem type of the HTTP API, with its status and title: docs/api/hub/http.md. A name never changes once
 * released (ADR 0031).
 */
export const PROBLEMS = {
  validation: { status: 400, title: "The request is not valid" },
  unauthenticated: { status: 401, title: "You are not logged in" },
  "session-expired": { status: 401, title: "The session has expired" },
  "invalid-credentials": { status: 401, title: "The email or password is wrong" },
  forbidden: { status: 403, title: "You may not do this" },
  "origin-mismatch": { status: 403, title: "The request comes from another origin" },
  "entitlement-required": { status: 403, title: "The organization's plan does not include this" },
  "not-found": { status: 404, title: "Not found" },
  conflict: { status: 409, title: "The request conflicts with the current state" },
  "payload-too-large": { status: 413, title: "The request body is too large" },
  "rate-limited": { status: 429, title: "Too many requests" },
  internal: { status: 500, title: "The hub failed to handle the request" },
  "not-ready": { status: 503, title: "The hub is not ready" },
} as const;

export type ProblemName = keyof typeof PROBLEMS;

/** Where in the request a field failed its schema; `query` is Fastify's `querystring`. */
export type FieldLocation = "body" | "query" | "params" | "headers";

/** One field that failed its schema: a JSON Pointer into the part of the request named by `in`. */
export interface FieldError {
  path: string;
  in: FieldLocation;
  message: string;
}

/** What a problem adds to its type, title and status. */
export interface ProblemDetails {
  detail?: string;
  errors?: readonly FieldError[];
}

/** An RFC 9457 problem document as the hub sends it. */
export interface Problem extends ProblemDetails {
  type: `urn:micafox:problem:${ProblemName}`;
  title: string;
  status: number;
  requestId: string;
}

/** Builds the problem document of `name` for the request `requestId`. */
export const createProblem = (name: ProblemName, requestId: string, details: ProblemDetails = {}): Problem => ({
  type: `urn:micafox:problem:${name}`,
  title: PROBLEMS[name].title,
  status: PROBLEMS[name].status,
  ...details,
  requestId,
});
