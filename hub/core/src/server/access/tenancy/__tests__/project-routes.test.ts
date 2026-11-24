import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";

let tenancy: TenancyApp;

beforeEach(async () => {
  tenancy = await openTenancyApp();
});

afterEach(async () => {
  await tenancy.close();
});

const projectsUrl = `/api/v1/orgs/${ORG_A}/projects`;

describe("POST /api/v1/orgs/{orgId}/projects", () => {
  it("creates a project for an admin and answers it", async () => {
    const reply = await tenancy.post("adminA", projectsUrl, { name: "Billing" });

    expect(reply).toMatchObject({ status: 201, body: { orgId: ORG_A, name: "Billing" } });
    expect([reply.body.id, reply.body.createdAt].map((value) => typeof value)).toEqual(["string", "string"]);
  });

  it("starts the project with a production environment", async () => {
    const { body: project } = await tenancy.post("ownerA", projectsUrl, { name: "Billing" });

    const environments = await tenancy.get("ownerA", `/api/v1/projects/${String(project.id)}/environments`);

    expect(environments.body.items).toMatchObject([{ projectId: project.id, name: "production" }]);
  });

  it("trims the name", async () => {
    const reply = await tenancy.post("ownerA", projectsUrl, { name: "  Billing  " });

    expect(reply.body).toMatchObject({ name: "Billing" });
  });

  it("answers 409 conflict for a name taken in another case", async () => {
    await tenancy.post("ownerA", projectsUrl, { name: "Billing" });

    const reply = await tenancy.post("adminA", projectsUrl, { name: " BILLING " });

    expect(reply).toMatchObject({ status: 409, body: { type: "urn:micafox:problem:conflict" } });
  });

  it("answers 400 validation for a name that is empty after trimming", async () => {
    const reply = await tenancy.post("ownerA", projectsUrl, { name: "   " });

    expect(reply).toMatchObject({
      status: 400,
      body: { type: "urn:micafox:problem:validation", errors: [{ path: "/name", in: "body" }] },
    });
  });

  it("answers 403 forbidden to a member", async () => {
    const reply = await tenancy.post("memberA", projectsUrl, { name: "Billing" });

    expect(reply).toMatchObject({ status: 403, body: { type: "urn:micafox:problem:forbidden" } });
  });

  it("answers 404 to a non-member, before it looks at the body", async () => {
    const reply = await tenancy.post("ownerB", projectsUrl, { name: "" });

    expect(reply).toMatchObject({ status: 404, body: { type: "urn:micafox:problem:not-found" } });
  });

  it("answers 401 unauthenticated when nobody is logged in", async () => {
    const reply = await tenancy.post(undefined, projectsUrl, { name: "Billing" });

    expect(reply).toMatchObject({ status: 401, body: { type: "urn:micafox:problem:unauthenticated" } });
  });
});

describe("GET /api/v1/orgs/{orgId}/projects", () => {
  it("lists the projects to a member, by name", async () => {
    await tenancy.post("ownerA", projectsUrl, { name: "beta" });
    await tenancy.post("ownerA", projectsUrl, { name: "Alpha" });

    const reply = await tenancy.get("memberA", projectsUrl);

    expect((reply.body.items as Array<{ name: string }>).map((project) => project.name)).toEqual(["Alpha", "beta"]);
  });

  it("pages the list with limit and cursor", async () => {
    await Promise.all(["a", "b", "c"].map(async (name) => await tenancy.post("ownerA", projectsUrl, { name })));

    const first = await tenancy.get("ownerA", `${projectsUrl}?limit=2`);
    const second = await tenancy.get("ownerA", `${projectsUrl}?limit=2&cursor=${String(first.body.nextCursor)}`);

    expect([
      (first.body.items as Array<{ name: string }>).map((project) => project.name),
      (second.body.items as Array<{ name: string }>).map((project) => project.name),
      second.body.nextCursor,
    ]).toEqual([["a", "b"], ["c"], undefined]);
  });

  it("answers 400 validation for a cursor the hub did not make", async () => {
    const reply = await tenancy.get("ownerA", `${projectsUrl}?cursor=AA`);

    expect(reply).toMatchObject({ status: 400, body: { errors: [{ path: "/cursor", in: "query" }] } });
  });

  it("answers 401 before it checks the path, to nobody logged in", async () => {
    const reply = await tenancy.get(undefined, "/api/v1/orgs/acme/projects");

    expect(reply.status).toBe(401);
  });

  it("answers 404 to a non-member", async () => {
    const reply = await tenancy.get("nobody", projectsUrl);

    expect(reply.status).toBe(404);
  });

  it("answers 400 validation for an id that is not a UUID", async () => {
    const reply = await tenancy.get("ownerA", "/api/v1/orgs/acme/projects");

    expect(reply).toMatchObject({ status: 400, body: { errors: [{ path: "/orgId", in: "params" }] } });
  });
});

describe("/api/v1/projects/{projectId}", () => {
  const createProject = async (name: string): Promise<string> =>
    String((await tenancy.post("ownerA", projectsUrl, { name })).body.id);

  it("reads a project for a member", async () => {
    const id = await createProject("Billing");

    const reply = await tenancy.get("memberA", `/api/v1/projects/${id}`);

    expect(reply).toMatchObject({ status: 200, body: { id, name: "Billing", orgId: ORG_A } });
  });

  it("renames a project for an admin", async () => {
    const id = await createProject("Billing");

    const reply = await tenancy.patch("adminA", `/api/v1/projects/${id}`, { name: "Invoices" });

    expect(reply).toMatchObject({ status: 200, body: { id, name: "Invoices" } });
  });

  it("lets a project change only the case of its own name", async () => {
    const id = await createProject("billing");

    const reply = await tenancy.patch("adminA", `/api/v1/projects/${id}`, { name: "Billing" });

    expect(reply).toMatchObject({ status: 200, body: { name: "Billing" } });
  });

  it("answers 409 conflict for a rename to a name another project has", async () => {
    await createProject("Billing");
    const id = await createProject("Invoices");

    const reply = await tenancy.patch("adminA", `/api/v1/projects/${id}`, { name: "billing" });

    expect(reply).toMatchObject({ status: 409, body: { type: "urn:micafox:problem:conflict" } });
  });

  it("answers 403 forbidden to a member who renames", async () => {
    const id = await createProject("Billing");

    const reply = await tenancy.patch("memberA", `/api/v1/projects/${id}`, { name: "Invoices" });

    expect(reply.status).toBe(403);
  });

  it("answers 404 for an id nobody holds, before it looks at the body", async () => {
    const reply = await tenancy.patch("adminA", "/api/v1/projects/6f1c0f0e-6a3e-4e55-9d0c-6f1c1d2b8a99", { name: "" });

    expect(reply.status).toBe(404);
  });

  it("answers 404 for an id nobody holds, also to a member who may not rename", async () => {
    const reply = await tenancy.patch("memberA", "/api/v1/projects/6f1c0f0e-6a3e-4e55-9d0c-6f1c1d2b8a99", {
      name: "Invoices",
    });

    expect(reply.status).toBe(404);
  });
});
