import { afterEach, describe, expect, it, vi } from "vitest";

import { openTenancyApp } from "../../../../test/access/tenancy-app.js";
import type { TenancyApp } from "../../../../test/access/tenancy-app.js";
import { ORG_A, ORG_B } from "../../../../test/db/test-database.js";
import { emptyFeature, paidFeature, pingFeature } from "../../../../test/feature/fixtures.js";
import type { EntitlementSource } from "../../access/index.js";
import { defineExtension } from "../contract.js";

let tenancy: TenancyApp | undefined;

afterEach(async () => {
  await tenancy?.close();
  tenancy = undefined;
});

const PROBLEM = "urn:micafox:problem:entitlement-required";

const grantFixturePlan: EntitlementSource = async () => await Promise.resolve(new Set(["fixture-plan"]));

const openPaid = async (sources: readonly EntitlementSource[] = []): Promise<TenancyApp> => {
  tenancy = await openTenancyApp({
    features: [pingFeature("notes")],
    extension: defineExtension({ features: [paidFeature("fixture")], sources }),
  });
  return tenancy;
};

describe("addFeatureRoutes", () => {
  it("serves a feature's server under /api/v1/<name> and its internal under /api/internal/<name>", async () => {
    tenancy = await openTenancyApp({
      features: [
        pingFeature("notes", {
          internal: (app) => {
            app.get("/panel", () => ({ panel: true }));
          },
        }),
      ],
    });

    const replies = [
      await tenancy.get("ownerA", `/api/v1/notes/orgs/${ORG_A}/ping`),
      await tenancy.get("ownerA", "/api/internal/notes/panel"),
      await tenancy.get("ownerA", "/api/v1/notes/panel"),
    ];

    expect(replies.map(({ status, body }) => [status, body.pong ?? body.panel])).toEqual([
      [200, ORG_A],
      [200, true],
      [404, undefined],
    ]);
  });

  it("answers 401 to nobody before a feature's route runs", async () => {
    tenancy = await openTenancyApp({ features: [pingFeature("notes")] });

    const reply = await tenancy.get(undefined, `/api/v1/notes/orgs/${ORG_A}/ping`);

    expect(reply).toMatchObject({ status: 401, body: { type: "urn:micafox:problem:unauthenticated" } });
  });

  it("keeps a feature's hooks to itself", async () => {
    tenancy = await openTenancyApp({
      features: [
        pingFeature("alpha", {
          server: (app) => {
            app.addHook("onSend", async (_request, reply, payload) => {
              void reply.header("x-alpha", "1");
              return await Promise.resolve(payload);
            });
            app.get("/ping", () => ({ pong: true }));
          },
        }),
        pingFeature("beta", {
          server: (app) => {
            app.get("/ping", () => ({ pong: true }));
          },
        }),
      ],
    });

    const [alpha, beta] = await Promise.all(
      ["alpha", "beta"].map(
        async (name) =>
          await tenancy?.app.inject({ url: `/api/v1/${name}/ping`, headers: { "x-test-actor": "ownerA" } }),
      ),
    );

    expect([alpha?.headers["x-alpha"], beta?.headers["x-alpha"]]).toEqual(["1", undefined]);
  });

  it("lets a core feature's routes through without ever asking a source", async () => {
    const source = vi.fn(grantFixturePlan);
    const app = await openPaid([source]);

    const replies = [
      await app.get("ownerA", `/api/v1/notes/orgs/${ORG_A}/ping`),
      await app.get("ownerA", `/api/v1/notes/by-query?org=${ORG_A}`),
    ];

    expect(replies.map(({ status }) => status)).toEqual([200, 200]);
    expect(source).not.toHaveBeenCalled();
  });

  it.each([
    ["the organization in the path and no helper of the core", `/api/v1/fixture/orgs/${ORG_A}/bare`],
    ["the organization in the path", `/api/v1/fixture/orgs/${ORG_A}/ping`],
    ["an organization named in the query", `/api/v1/fixture/by-query?org=${ORG_A}`],
  ])("answers a member 403 entitlement-required on an extension route with %s", async (_name, url) => {
    const app = await openPaid();

    const reply = await app.get("memberA", url);

    expect(reply).toMatchObject({ status: 403, body: { type: PROBLEM, title: expect.any(String) as unknown } });
  });

  it("answers 403 entitlement-required on an extension route with an id only", async () => {
    const app = await openPaid();
    const created = await app.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });

    const reply = await app.get("ownerA", `/api/v1/fixture/projects/${String(created.body.id)}`);

    expect(reply).toMatchObject({ status: 403, body: { type: PROBLEM } });
  });

  it("rolls back what a refused route with an id only did in the organization", async () => {
    const app = await openPaid();
    const created = await app.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });

    await app.post("ownerA", `/api/v1/fixture/projects/${String(created.body.id)}/copies`, { name: "Copy" });

    const projects = await app.get("ownerA", `/api/v1/orgs/${ORG_A}/projects`);
    expect((projects.body.items as Array<{ name: string }>).map((project) => project.name)).toEqual(["Billing"]);
  });

  it("answers 403 before it checks the body of a route with the organization in its path", async () => {
    const app = await openPaid();

    const reply = await app.post("memberA", `/api/v1/fixture/orgs/${ORG_A}/bare`, { name: "" });

    expect(reply).toMatchObject({ status: 403, body: { type: PROBLEM } });
  });

  it("answers a non-member 404 on an extension route, so nothing says the organization exists", async () => {
    const app = await openPaid();

    const replies = [
      await app.get("ownerB", `/api/v1/fixture/orgs/${ORG_A}/ping`),
      await app.get("ownerB", `/api/v1/fixture/orgs/${ORG_A}/bare`),
      await app.get("ownerB", `/api/v1/fixture/by-query?org=${ORG_A}`),
    ];

    expect(replies.map(({ status }) => status)).toEqual([404, 404, 404]);
  });

  it("refuses by organization: an organization that has the entitlement is served, another is not", async () => {
    const onlyOrgA: EntitlementSource = async (orgId) =>
      await Promise.resolve(new Set(orgId === ORG_A ? ["fixture-plan"] : []));
    const app = await openPaid([onlyOrgA]);

    const replies = [
      await app.get("ownerA", `/api/v1/fixture/orgs/${ORG_A}/ping`),
      await app.get("ownerB", `/api/v1/fixture/orgs/${ORG_B}/ping`),
    ];

    expect(replies.map(({ status }) => status)).toEqual([200, 403]);
  });

  it("serves all three kinds of extension route once a source grants the entitlement", async () => {
    const app = await openPaid([grantFixturePlan]);
    const created = await app.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });

    const replies = [
      await app.get("memberA", `/api/v1/fixture/orgs/${ORG_A}/ping`),
      await app.get("memberA", `/api/v1/fixture/by-query?org=${ORG_A}`),
      await app.get("ownerA", `/api/v1/fixture/projects/${String(created.body.id)}`),
    ];

    expect(replies.map(({ status }) => status)).toEqual([200, 200, 200]);
  });

  it("gives every member of an entitled organization the extension feature's own actions", async () => {
    tenancy = await openTenancyApp({
      extension: defineExtension({
        features: [
          paidFeature("fixture", {
            server: (app, access) => {
              app.get("/read", async (request) => {
                const context = await access.inOrganization(request, ORG_A);
                access.requireCan(context, "fixture.report.read");
                return { pong: true };
              });
            },
          }),
        ],
        sources: [grantFixturePlan],
      }),
    });

    const reply = await tenancy.get("memberA", "/api/v1/fixture/read");

    expect(reply).toEqual({ status: 200, body: { pong: true } });
  });

  it("answers 500 and never serves the route when a source fails", async () => {
    const app = await openPaid([async () => await Promise.reject(new Error("source down"))]);

    const reply = await app.get("memberA", `/api/v1/fixture/orgs/${ORG_A}/ping`);

    expect(reply.status).toBe(500);
  });

  it("registers a feature with no internal routes without an /api/internal path", async () => {
    tenancy = await openTenancyApp({ features: [emptyFeature("quiet")] });

    const reply = await tenancy.get("ownerA", "/api/internal/quiet/anything");

    expect(reply.status).toBe(404);
  });
});
