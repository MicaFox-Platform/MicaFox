import { Readable } from "node:stream";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApp } from "../../../../test/server/app.js";
import type { LogCapture } from "../../../../test/server/log-capture.js";
import { HttpProblem } from "../index.js";
import type { HubApp } from "../index.js";

const apps: HubApp[] = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

const create = (): { app: HubApp; log: LogCapture } => {
  const created = createTestApp();
  const { app } = created;
  app.post(
    "/api/v1/orgs/:orgId/projects",
    {
      schema: {
        params: Type.Object({ orgId: Type.String({ format: "uuid" }) }),
        querystring: Type.Object({ dryRun: Type.Optional(Type.Boolean()) }),
        body: Type.Object({ name: Type.String({ maxLength: 100 }) }),
      },
    },
    () => ({ id: "p1" }),
  );
  app.get("/api/v1/taken", () => {
    throw new HttpProblem("conflict", { detail: "A project named checkout exists" });
  });
  app.get("/api/v1/broken", () => {
    throw new Error("connect ECONNREFUSED 10.0.0.3:5432 as role micafox_app");
  });
  app.get("/api/v1/thrown-string", () => {
    // A library that throws something other than an Error
    throw "connection lost" as unknown as Error;
  });
  apps.push(app);
  return created;
};

const ORG_ID = "4d0b6c1e-6f0a-4c8e-9a51-1c2f0e7d8b3a";
const PROJECTS = `/api/v1/orgs/${ORG_ID}/projects`;

const errorLines = (log: LogCapture): Array<Record<string, unknown>> => log.lines().filter((line) => line.level === 50);

describe("createApp errors", () => {
  it("answers a body that fails its schema with 400 validation, the field's path and the request id", async () => {
    const { app } = create();

    const response = await app.inject({ method: "POST", url: PROJECTS, payload: { name: { first: "Ann" } } });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
    expect(response.json()).toEqual({
      type: "urn:micafox:problem:validation",
      title: "The request is not valid",
      status: 400,
      detail: "name: must be string",
      errors: [{ path: "/name", in: "body", message: "must be string" }],
      requestId: response.headers["x-request-id"],
    });
  });

  it("points at a missing field by its own path", async () => {
    const { app } = create();

    const response = await app.inject({ method: "POST", url: PROJECTS, payload: {} });

    expect(response.json()).toMatchObject({
      errors: [{ path: "/name", in: "body", message: "must have required property 'name'" }],
    });
  });

  it("says which part of the request failed: the path parameters", async () => {
    const { app } = create();

    const response = await app.inject({ method: "POST", url: "/api/v1/orgs/acme/projects", payload: { name: "a" } });

    expect(response.json()).toMatchObject({
      status: 400,
      errors: [{ path: "/orgId", in: "params", message: 'must match format "uuid"' }],
    });
  });

  it("says which part of the request failed: the query", async () => {
    const { app } = create();

    const response = await app.inject({ method: "POST", url: `${PROJECTS}?dryRun=maybe`, payload: { name: "a" } });

    expect(response.json()).toMatchObject({
      status: 400,
      errors: [{ path: "/dryRun", in: "query", message: "must be boolean" }],
    });
  });

  it("answers a body over 1 MiB with 413 payload-too-large", async () => {
    const { app } = create();

    const response = await app.inject({
      method: "POST",
      url: PROJECTS,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "a".repeat(1024 * 1024) }),
    });

    expect(response.json()).toMatchObject({ type: "urn:micafox:problem:payload-too-large", status: 413 });
  });

  it("answers a streamed body over 1 MiB without a length with 413 payload-too-large", async () => {
    const { app } = create();
    const chunk = Buffer.alloc(64 * 1024, "a");

    const response = await app.inject({
      method: "POST",
      url: PROJECTS,
      headers: { "content-type": "application/json" },
      payload: Readable.from(Array.from({ length: 17 }, () => chunk)),
    });

    expect(response.json()).toMatchObject({ type: "urn:micafox:problem:payload-too-large", status: 413 });
  });

  it("answers malformed JSON with 400 validation and why", async () => {
    const { app } = create();

    const response = await app.inject({
      method: "POST",
      url: PROJECTS,
      headers: { "content-type": "application/json" },
      payload: '{"name": ',
    });

    expect(response.json()).toMatchObject({
      type: "urn:micafox:problem:validation",
      status: 400,
      detail: expect.stringContaining("not valid JSON") as unknown,
    });
  });

  it("answers an unsupported content type with 400 validation", async () => {
    const { app } = create();

    const response = await app.inject({
      method: "POST",
      url: PROJECTS,
      headers: { "content-type": "application/xml" },
      payload: "<project/>",
    });

    expect(response.json()).toMatchObject({ type: "urn:micafox:problem:validation", status: 400 });
  });

  it("answers a malformed URL with 400 validation", async () => {
    const { app } = create();

    const response = await app.inject({ url: "/api/v1/%E0" });

    expect(response.json()).toMatchObject({
      type: "urn:micafox:problem:validation",
      status: 400,
      requestId: response.headers["x-request-id"],
    });
  });

  it.each([
    ["an unknown route", "GET", "/api/v1/nothing-here"],
    ["a known route with another method", "DELETE", PROJECTS],
  ] as const)("answers %s with 404 not-found", async (_case, method, url) => {
    const { app } = create();

    const response = await app.inject({ method, url });

    expect(response.json()).toMatchObject({ type: "urn:micafox:problem:not-found", status: 404 });
  });

  it("answers an HttpProblem with its type, status and detail", async () => {
    const { app } = create();

    const response = await app.inject({ url: "/api/v1/taken" });

    expect(response.json()).toEqual({
      type: "urn:micafox:problem:conflict",
      title: "The request conflicts with the current state",
      status: 409,
      detail: "A project named checkout exists",
      requestId: response.headers["x-request-id"],
    });
  });

  it("never logs a client's error at error level", async () => {
    const { app, log } = create();

    await app.inject({ method: "POST", url: PROJECTS, payload: {} });
    await app.inject({ url: "/api/v1/taken" });
    await app.inject({ url: "/api/v1/%E0" });

    expect(errorLines(log)).toEqual([]);
  });
});

describe("createApp unexpected errors", () => {
  it("answers 500 internal without the error's message", async () => {
    const { app } = create();

    const response = await app.inject({ url: "/api/v1/broken" });

    expect(response.json()).toEqual({
      type: "urn:micafox:problem:internal",
      title: "The hub failed to handle the request",
      status: 500,
      requestId: response.headers["x-request-id"],
    });
    expect(response.body).not.toContain("ECONNREFUSED");
  });

  it("logs the error with its stack and the request id", async () => {
    const { app, log } = create();

    const response = await app.inject({ url: "/api/v1/broken" });

    expect(errorLines(log)).toEqual([
      expect.objectContaining({
        msg: "request.failed",
        reqId: response.headers["x-request-id"],
        err: expect.objectContaining({
          message: "connect ECONNREFUSED 10.0.0.3:5432 as role micafox_app",
          stack: expect.stringContaining("index-errors.test.ts") as unknown,
        }) as unknown,
      }),
    ]);
  });

  it("answers 500 internal when a route throws something other than an Error", async () => {
    const { app } = create();

    const response = await app.inject({ url: "/api/v1/thrown-string" });

    expect(response.json()).toMatchObject({ type: "urn:micafox:problem:internal", status: 500 });
  });
});
