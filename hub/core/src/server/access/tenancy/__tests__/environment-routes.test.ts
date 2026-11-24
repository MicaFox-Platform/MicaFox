import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";

let tenancy: TenancyApp;
let projectId: string;

beforeEach(async () => {
  tenancy = await openTenancyApp();
  const created = await tenancy.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });
  projectId = String(created.body.id);
});

afterEach(async () => {
  await tenancy.close();
});

const environmentsUrl = (): string => `/api/v1/projects/${projectId}/environments`;

const namesOf = (body: Record<string, unknown>): string[] =>
  (body.items as Array<{ name: string }>).map((environment) => environment.name);

describe("POST /api/v1/projects/{projectId}/environments", () => {
  it("creates an environment for an admin and answers it", async () => {
    const reply = await tenancy.post("adminA", environmentsUrl(), { name: "staging" });

    expect(reply).toMatchObject({ status: 201, body: { projectId, name: "staging" } });
    expect([reply.body.id, reply.body.createdAt].map((value) => typeof value)).toEqual(["string", "string"]);
  });

  it("answers 409 conflict for a name taken in another case, also production", async () => {
    const reply = await tenancy.post("adminA", environmentsUrl(), { name: "Production" });

    expect(reply).toMatchObject({ status: 409, body: { type: "urn:micafox:problem:conflict" } });
  });

  it("answers 400 validation for a name with a control character", async () => {
    const reply = await tenancy.post("adminA", environmentsUrl(), { name: "stag\ting" });

    expect(reply).toMatchObject({ status: 400, body: { errors: [{ path: "/name", in: "body" }] } });
  });

  it("answers 403 forbidden to a member", async () => {
    const reply = await tenancy.post("memberA", environmentsUrl(), { name: "staging" });

    expect(reply.status).toBe(403);
  });

  it("answers 404 for a project that does not exist", async () => {
    const reply = await tenancy.post("adminA", "/api/v1/projects/6f1c0f0e-6a3e-4e55-9d0c-6f1c1d2b8a99/environments", {
      name: "staging",
    });

    expect(reply.status).toBe(404);
  });
});

describe("GET /api/v1/projects/{projectId}/environments", () => {
  it("lists the environments to a member, by name", async () => {
    await tenancy.post("adminA", environmentsUrl(), { name: "staging" });
    await tenancy.post("adminA", environmentsUrl(), { name: "Dev" });

    const reply = await tenancy.get("memberA", environmentsUrl());

    expect(namesOf(reply.body)).toEqual(["Dev", "production", "staging"]);
  });

  it("answers 400 validation for a cursor the hub did not make", async () => {
    const reply = await tenancy.get("adminA", `${environmentsUrl()}?cursor=not!base64`);

    expect(reply).toMatchObject({ status: 400, body: { errors: [{ path: "/cursor", in: "query" }] } });
  });

  it("pages the list with limit and cursor", async () => {
    await tenancy.post("adminA", environmentsUrl(), { name: "staging" });

    const first = await tenancy.get("adminA", `${environmentsUrl()}?limit=1`);
    const second = await tenancy.get("adminA", `${environmentsUrl()}?limit=1&cursor=${String(first.body.nextCursor)}`);

    expect([namesOf(first.body), namesOf(second.body), second.body.nextCursor]).toEqual([
      ["production"],
      ["staging"],
      undefined,
    ]);
  });
});

describe("PATCH /api/v1/environments/{environmentId}", () => {
  const stagingId = async (): Promise<string> =>
    String((await tenancy.post("adminA", environmentsUrl(), { name: "staging" })).body.id);

  it("renames an environment for an admin", async () => {
    const id = await stagingId();

    const reply = await tenancy.patch("adminA", `/api/v1/environments/${id}`, { name: "qa" });

    expect(reply).toMatchObject({ status: 200, body: { id, projectId, name: "qa" } });
  });

  it("answers 409 conflict for a rename to a name the project has", async () => {
    const id = await stagingId();

    const reply = await tenancy.patch("adminA", `/api/v1/environments/${id}`, { name: "PRODUCTION" });

    expect(reply.status).toBe(409);
  });

  it("answers 403 forbidden to a member", async () => {
    const id = await stagingId();

    const reply = await tenancy.patch("memberA", `/api/v1/environments/${id}`, { name: "qa" });

    expect(reply.status).toBe(403);
  });

  it("answers 404 for an id nobody holds", async () => {
    const reply = await tenancy.patch("adminA", "/api/v1/environments/6f1c0f0e-6a3e-4e55-9d0c-6f1c1d2b8a99", {
      name: "qa",
    });

    expect(reply.status).toBe(404);
  });
});
