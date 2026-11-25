import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTORS, openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";
import type { HubEvent } from "../../../events/index.js";

let tenancy: TenancyApp;
let published: HubEvent[];

beforeEach(async () => {
  tenancy = await openTenancyApp();
  published = [];
  tenancy.events.bus.subscribe((event) => published.push(event));
});

afterEach(async () => {
  await tenancy.close();
});

const projectsUrl = `/api/v1/orgs/${ORG_A}/projects`;

const projectIdOf = async (name = "Billing"): Promise<string> =>
  String((await tenancy.post("ownerA", projectsUrl, { name })).body.id);

describe("events of projects", () => {
  it("publishes project.created with the actor and the project's id once it is created", async () => {
    const reply = await tenancy.post("adminA", projectsUrl, { name: "Billing" });

    expect(published).toEqual([
      {
        type: "project.created",
        orgId: ORG_A,
        actor: { userId: ACTORS.adminA.userId },
        data: { projectId: reply.body.id },
      },
    ]);
  });

  it("publishes nothing for a project that is refused: a taken name rolls back", async () => {
    await projectIdOf();
    published.length = 0;

    const reply = await tenancy.post("ownerA", projectsUrl, { name: "billing" });

    expect([reply.status, published]).toEqual([409, []]);
  });

  it("publishes nothing for a member who may not create", async () => {
    await tenancy.post("memberA", projectsUrl, { name: "Billing" });

    expect(published).toEqual([]);
  });

  it("publishes project.updated on a rename, and nothing when the name is taken", async () => {
    const id = await projectIdOf();
    await projectIdOf("Search");
    published.length = 0;

    const taken = await tenancy.patch("adminA", `/api/v1/projects/${id}`, { name: "search" });
    const renamed = await tenancy.patch("adminA", `/api/v1/projects/${id}`, { name: "Payments" });

    expect([taken.status, renamed.status, published]).toEqual([
      409,
      200,
      [{ type: "project.updated", orgId: ORG_A, actor: { userId: ACTORS.adminA.userId }, data: { projectId: id } }],
    ]);
  });
});

describe("events of environments", () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = await projectIdOf();
    published.length = 0;
  });

  it("publishes environment.created with the environment and its project", async () => {
    const reply = await tenancy.post("adminA", `/api/v1/projects/${projectId}/environments`, { name: "staging" });

    expect(published).toEqual([
      {
        type: "environment.created",
        orgId: ORG_A,
        environmentId: reply.body.id,
        actor: { userId: ACTORS.adminA.userId },
        data: { projectId, environmentId: reply.body.id },
      },
    ]);
  });

  it("publishes nothing for an environment whose name is taken", async () => {
    const reply = await tenancy.post("adminA", `/api/v1/projects/${projectId}/environments`, { name: "Production" });

    expect([reply.status, published]).toEqual([409, []]);
  });

  it("publishes environment.updated on a rename, and nothing when the name is taken", async () => {
    const created = await tenancy.post("adminA", `/api/v1/projects/${projectId}/environments`, { name: "staging" });
    const id = String(created.body.id);
    published.length = 0;

    const taken = await tenancy.patch("adminA", `/api/v1/environments/${id}`, { name: "PRODUCTION" });
    const renamed = await tenancy.patch("adminA", `/api/v1/environments/${id}`, { name: "qa" });

    expect([taken.status, renamed.status, published]).toEqual([
      409,
      200,
      [
        {
          type: "environment.updated",
          orgId: ORG_A,
          environmentId: id,
          actor: { userId: ACTORS.adminA.userId },
          data: { projectId, environmentId: id },
        },
      ],
    ]);
  });
});
