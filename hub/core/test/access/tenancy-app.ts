import { sql } from "kysely";

import { addAccess, createEntitlements } from "../../src/server/access/index.js";
import type { Access, Actor, ActorResolver } from "../../src/server/access/index.js";
import type { HubApp } from "../../src/server/app/index.js";
import { CORE_MIGRATIONS, migrate } from "../../src/server/db/index.js";
import type { Events } from "../../src/server/events/index.js";
import { addFeatureRoutes, createFeatureRegistry, createGate } from "../../src/server/feature/index.js";
import type { Extension, Feature } from "../../src/server/feature/index.js";
import { openTestDatabase, ORG_A, ORG_B } from "../db/test-database.js";
import type { TestDatabase } from "../db/test-database.js";
import { createTestEvents } from "../events/test-events.js";
import { createTestApp } from "../server/app.js";
import type { LogCapture } from "../server/log-capture.js";

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
  /** What the hub uses of access: the key lookup and the revoke hooks. */
  access: Access;
  /** The bus the routes publish to and the streams of the app. */
  events: Events;
  log: LogCapture;
  /** A request as `name`, or as nobody logged in; the body is JSON. */
  get: (name: ActorName | undefined, url: string) => Promise<Reply>;
  post: (name: ActorName | undefined, url: string, body: Record<string, unknown>) => Promise<Reply>;
  patch: (name: ActorName | undefined, url: string, body: Record<string, unknown>) => Promise<Reply>;
  /** A `DELETE`; an answer without a body has an empty `body`. */
  delete: (name: ActorName | undefined, url: string) => Promise<Reply>;
  close: () => Promise<void>;
}

// Read only by this test's resolver, so requests sent at once keep their own actor; the hub's resolver reads sessions
const ACTOR_HEADER = "x-test-actor";

const isActorName = (value: unknown): value is ActorName => typeof value === "string" && Object.hasOwn(ACTORS, value);

const resolveTestActor: ActorResolver = async (request) => {
  const name = request.headers[ACTOR_HEADER];
  return await Promise.resolve(isActorName(name) ? ACTORS[name] : undefined);
};

// The test database, migrated, with organizations A and B
const openDatabaseWithOrganizations = async (): Promise<TestDatabase> => {
  const test = await openTestDatabase();
  await migrate(
    test.db,
    { url: test.ownerUrl ?? test.url, packages: [CORE_MIGRATIONS], log: test.logger },
    new AbortController().signal,
  );
  await test.db.system("test: add the organizations", async (trx) => {
    await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme'), (${ORG_B}, 'Globex')`.execute(trx);
  });
  return test;
};

/** Opens the test database, migrates it, adds the two organizations and the access plugin to an app. */
export const openTenancyApp = async (
  options: { publicUrl?: string; features?: readonly Feature[]; extension?: Extension } = {},
): Promise<TenancyApp> => {
  const test = await openDatabaseWithOrganizations();
  const { app, log } = createTestApp();
  const registry = createFeatureRegistry(options.features ?? [], options.extension);
  const entitlements = createEntitlements({ sources: options.extension?.sources ?? [], now: Date.now });
  const gate = createGate(registry, entitlements);
  const events = createTestEvents();
  const access = addAccess(app, {
    db: test.db,
    events,
    resolveActor: resolveTestActor,
    features: registry.features.map(({ feature }) => feature.name),
    entitlements,
    addFeatureRoutes: (scope, authorization) => {
      addFeatureRoutes(scope, { registry, authorization, gate });
    },
    publicUrl: () => options.publicUrl ?? "https://hub.example.com",
  });
  await app.ready();

  const send = async (
    name: ActorName | undefined,
    request: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: Record<string, unknown> },
  ): Promise<Reply> => {
    const response = await app.inject({ ...request, headers: name === undefined ? {} : { [ACTOR_HEADER]: name } });
    return { status: response.statusCode, body: response.body === "" ? {} : response.json<Record<string, unknown>>() };
  };
  return {
    app,
    test,
    access,
    events,
    log,
    get: async (name, url) => await send(name, { method: "GET", url }),
    post: async (name, url, payload) => await send(name, { method: "POST", url, payload }),
    patch: async (name, url, payload) => await send(name, { method: "PATCH", url, payload }),
    delete: async (name, url) => await send(name, { method: "DELETE", url }),
    close: async () => {
      await app.close();
      await test.close();
    },
  };
};
