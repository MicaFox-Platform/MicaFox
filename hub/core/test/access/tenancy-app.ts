import { sql } from "kysely";

import { addAccess } from "../../src/server/access/index.js";
import type { Actor, ActorResolver } from "../../src/server/access/index.js";
import type { HubApp } from "../../src/server/app/index.js";
import { CORE_MIGRATIONS, migrate } from "../../src/server/db/index.js";
import { openTestDatabase, ORG_A, ORG_B } from "../db/test-database.js";
import type { TestDatabase } from "../db/test-database.js";
import { createTestApp } from "../server/app.js";

/** Who the tests act as: each is a user of the organizations named. */
export const ACTORS = {
  ownerA: { userId: "a0000000-0000-4000-8000-000000000001", memberships: [{ orgId: ORG_A, role: "owner" }] },
  adminA: { userId: "a0000000-0000-4000-8000-000000000002", memberships: [{ orgId: ORG_A, role: "admin" }] },
  memberA: { userId: "a0000000-0000-4000-8000-000000000003", memberships: [{ orgId: ORG_A, role: "member" }] },
  ownerB: { userId: "b0000000-0000-4000-8000-000000000001", memberships: [{ orgId: ORG_B, role: "owner" }] },
  // A member of A and an admin of B: the two organizations a path with only an id is tried in
  both: {
    userId: "c0000000-0000-4000-8000-000000000001",
    memberships: [
      { orgId: ORG_A, role: "member" },
      { orgId: ORG_B, role: "admin" },
    ],
  },
  nobody: { userId: "d0000000-0000-4000-8000-000000000001", memberships: [] },
} as const satisfies Record<string, Actor>;

export type ActorName = keyof typeof ACTORS;

/** What a test reads of a response. */
export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** The access plugin over a migrated database with organizations A and B; each request says its actor. */
export interface TenancyApp {
  app: HubApp;
  test: TestDatabase;
  /** A request as `name`, or as nobody logged in; the body is JSON. */
  get: (name: ActorName | undefined, url: string) => Promise<Reply>;
  post: (name: ActorName | undefined, url: string, body: Record<string, unknown>) => Promise<Reply>;
  patch: (name: ActorName | undefined, url: string, body: Record<string, unknown>) => Promise<Reply>;
  close: () => Promise<void>;
}

// Read only by this test's resolver, so requests sent at once keep their own actor; the hub's resolver reads sessions
const ACTOR_HEADER = "x-test-actor";

const isActorName = (value: unknown): value is ActorName => typeof value === "string" && Object.hasOwn(ACTORS, value);

const resolveTestActor: ActorResolver = async (request) => {
  const name = request.headers[ACTOR_HEADER];
  return await Promise.resolve(isActorName(name) ? ACTORS[name] : undefined);
};

/** Opens the test database, migrates it, adds the two organizations and the access plugin to an app. */
export const openTenancyApp = async (): Promise<TenancyApp> => {
  const test = await openTestDatabase();
  await migrate(
    test.db,
    { url: test.ownerUrl ?? test.url, packages: [CORE_MIGRATIONS], log: test.logger },
    new AbortController().signal,
  );
  await test.db.system("test: add the organizations", async (trx) => {
    await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme'), (${ORG_B}, 'Globex')`.execute(trx);
  });
  const { app } = createTestApp();
  addAccess(app, { db: test.db, resolveActor: resolveTestActor, features: ["debugger"] });
  await app.ready();

  const send = async (
    name: ActorName | undefined,
    request: { method: "GET" | "POST" | "PATCH"; url: string; payload?: Record<string, unknown> },
  ): Promise<Reply> => {
    const response = await app.inject({ ...request, headers: name === undefined ? {} : { [ACTOR_HEADER]: name } });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  };
  return {
    app,
    test,
    get: async (name, url) => await send(name, { method: "GET", url }),
    post: async (name, url, payload) => await send(name, { method: "POST", url, payload }),
    patch: async (name, url, payload) => await send(name, { method: "PATCH", url, payload }),
    close: async () => {
      await app.close();
      await test.close();
    },
  };
};
