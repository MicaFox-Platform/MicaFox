import { describe, expect, it } from "vitest";

import { classifyError } from "../classify-error.js";
import { HttpProblem } from "../http-problem.js";

// An error as Fastify or a plugin raises it: a status, and a code when it is Fastify's own
const clientError = (statusCode: number, code?: string): Error =>
  Object.assign(new Error("Client error"), { statusCode, ...(code === undefined ? {} : { code }) });

describe("classifyError", () => {
  it("keeps a thrown HttpProblem as it is", () => {
    const answer = classifyError(new HttpProblem("forbidden", { detail: "Only admins create keys" }));

    expect(answer).toEqual({ name: "forbidden", details: { detail: "Only admins create keys" } });
  });

  it.each([
    [404, "FST_ERR_NOT_FOUND", "not-found"],
    [413, "FST_ERR_CTP_BODY_TOO_LARGE", "payload-too-large"],
    [415, "FST_ERR_CTP_INVALID_MEDIA_TYPE", "validation"],
    [414, "FST_ERR_MAX_PARAM_LENGTH", "validation"],
  ] as const)("maps Fastify's %i %s to %s with its message", (status, code, name) => {
    expect(classifyError(clientError(status, code))).toEqual({ name, details: { detail: "Client error" } });
  });

  it("answers a request body that broke off with validation and no message", () => {
    expect(classifyError(clientError(400, "ECONNRESET"))).toEqual({ name: "validation", details: {} });
  });

  it("treats an upstream service's 401 seen by a route as internal, not as the client's", () => {
    const upstream = clientError(401, "UND_ERR_RESPONSE_STATUS_CODE");

    expect(classifyError(upstream)).toEqual({ name: "internal" });
  });

  it.each([
    ["no status", new Error("boom")],
    ["a 5xx status", clientError(502)],
    ["a status below 400", clientError(302, "FST_ERR_REDIRECT")],
    ["a 4xx status but no code", clientError(404)],
    ["a value that is not an Error", "boom"],
  ])("treats an error with %s as internal", (_case, error) => {
    expect(classifyError(error)).toEqual({ name: "internal" });
  });
});
