import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { ActorName, Reply, TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A, ORG_B } from "../../../../../test/db/test-database.js";

let tenancy: TenancyApp;
let projectOfB: string;
let environmentOfB: string;

beforeEach(async () => {
  tenancy = await openTenancyApp();
  const project = await tenancy.post("ownerB", `/api/v1/orgs/${ORG_B}/projects`, { name: "Secret" });
  projectOfB = String(project.body.id);
  const environments = await tenancy.get("ownerB", `/api/v1/projects/${projectOfB}/environments`);
  environmentOfB = String((environments.body.items as Array<{ id: string }>)[0]?.id);
  await tenancy.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Public" });
});

afterEach(async () => {
  await tenancy.close();
});

type Call = (actor: ActorName) => Promise<Reply>;

// Every route of the tenancy, called with the ids of organization B
const routesWithIdsOfB: Array<[string, Call]> = [
  ["list projects", async (actor) => await tenancy.get(actor, `/api/v1/orgs/${ORG_B}/projects`)],
  ["create a project", async (actor) => await tenancy.post(actor, `/api/v1/orgs/${ORG_B}/projects`, { name: "Mine" })],
  ["read a project", async (actor) => await tenancy.get(actor, `/api/v1/projects/${projectOfB}`)],
  ["rename a project", async (actor) => await tenancy.patch(actor, `/api/v1/projects/${projectOfB}`, { name: "Mine" })],
  ["list environments", async (actor) => await tenancy.get(actor, `/api/v1/projects/${projectOfB}/environments`)],
  [
    "create an environment",
    async (actor) => await tenancy.post(actor, `/api/v1/projects/${projectOfB}/environments`, { name: "Mine" }),
  ],
  [
    "rename an environment",
    async (actor) => await tenancy.patch(actor, `/api/v1/environments/${environmentOfB}`, { name: "Mine" }),
  ],
];

const namesIn = (reply: Reply): string[] => (reply.body.items as Array<{ name: string }>).map((item) => item.name);

describe("isolation of organizations on the tenancy routes", () => {
  it.each(["ownerA", "adminA", "memberA", "nobody"] as const)(
    "answers 404 to %s on every route with B's ids",
    async (actor) => {
      const statuses = await Promise.all(routesWithIdsOfB.map(async ([, call]) => (await call(actor)).status));

      expect(statuses).toEqual(routesWithIdsOfB.map(() => 404));
    },
  );

  it("leaves B's project and its list untouched after A's attempts", async () => {
    await Promise.all(routesWithIdsOfB.map(async ([, call]) => await call("ownerA")));

    const project = await tenancy.get("ownerB", `/api/v1/projects/${projectOfB}`);
    const projects = await tenancy.get("ownerB", `/api/v1/orgs/${ORG_B}/projects`);
    const environments = await tenancy.get("ownerB", `/api/v1/projects/${projectOfB}/environments`);

    expect([project.body.name, namesIn(projects), namesIn(environments)]).toEqual([
      "Secret",
      ["Secret"],
      ["production"],
    ]);
  });

  it("never lists B's projects to an actor of A", async () => {
    const reply = await tenancy.get("ownerA", `/api/v1/orgs/${ORG_A}/projects`);

    expect(namesIn(reply)).toEqual(["Public"]);
  });

  it("lets the same name exist in both organizations", async () => {
    const reply = await tenancy.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "secret" });

    expect(reply.status).toBe(201);
  });

  it("finds a project by id in the organization that holds it, for an actor of both", async () => {
    const reply = await tenancy.get("both", `/api/v1/projects/${projectOfB}`);

    expect(reply).toMatchObject({ status: 200, body: { id: projectOfB, orgId: ORG_B } });
  });

  it("applies the role of the organization that holds the id, for an actor of both", async () => {
    const renamed = await tenancy.patch("both", `/api/v1/projects/${projectOfB}`, { name: "Renamed" });

    expect(renamed).toMatchObject({ status: 200, body: { name: "Renamed" } });
  });
});
