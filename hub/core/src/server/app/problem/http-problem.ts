import { PROBLEMS } from "./catalog.js";
import type { ProblemDetails, ProblemName } from "./catalog.js";

/** An error a route throws to answer with a problem of the catalog, such as `not-found` or `conflict`. */
export class HttpProblem extends Error {
  /** Fastify reads the status from here when it logs the error. */
  readonly statusCode: number;

  constructor(
    readonly problem: ProblemName,
    readonly details: ProblemDetails = {},
    /** Seconds for the `Retry-After` header of a `rate-limited` answer. */
    readonly retryAfterSeconds?: number,
  ) {
    super(details.detail ?? PROBLEMS[problem].title);
    this.name = "HttpProblem";
    this.statusCode = PROBLEMS[problem].status;
  }
}
