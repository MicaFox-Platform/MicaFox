import { afterEach, describe, expect, it } from "vitest";

import { openTestDatabase } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { createTestApp } from "../../../../test/server/app.js";
import type { HubApp } from "../../app/index.js";
import { addAccess } from "../index.js";
import type { ActorResolver } from "../index.js";

const apps: HubApp[] = [];
const databases: TestDatabase[] = [];

// The database connects on its first query, which these routes never make: they stop at the actor
const resolveNobody: ActorResolver = async () => {
  await Promise.resolve();
};

const create = async (resolveActor: ActorResolver): Promise<HubApp> => {
  const test = await openTestDatabase();
  databases.push(test);
  const { app } = createTestApp();
  addAccess(app, { db: test.db, resolveActor, features: [], publicUrl: () => "https://hub.example.com" });
  apps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
  await Promise.all(
    databases.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

describe("addAccess", () => {
  it("answers 401 unauthenticated when nobody is resolved", async () => {
    const app = await create(resolveNobody);

    const response = await app.inject({ url: "/api/v1/orgs/0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01/projects" });

    expect([response.statusCode, response.json<{ type: string }>().type]).toEqual([
      401,
      "urn:micafox:problem:unauthenticated",
    ]);
  });

  it("gives the resolver the request, so it can read what identifies the actor", async () => {
    const seen: string[] = [];
    const app = await create(async (request) => {
      seen.push(request.url);
      await Promise.resolve(undefined);
    });

    await app.inject({ url: "/api/v1/projects/0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01" });

    expect(seen).toEqual(["/api/v1/projects/0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01"]);
  });

  it("answers 500 internal when the resolver fails, without its message", async () => {
    const app = await create(async () => await Promise.reject(new Error("secret detail")));

    const response = await app.inject({ url: "/api/v1/orgs/0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01/projects" });

    expect([response.statusCode, response.body.includes("secret detail")]).toEqual([500, false]);
  });

  it("does not ask for an actor on routes outside its plugin", async () => {
    const app = await create(async () => await Promise.reject(new Error("must not run")));
    app.get("/healthz", () => "ok");

    const response = await app.inject({ url: "/healthz" });

    expect(response.statusCode).toBe(200);
  });
});
