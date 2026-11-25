import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";

import { addAccess, createEntitlements } from "../../src/server/access/index.js";
import { createPasswordHasher } from "../../src/server/access/password/index.js";
import type { HubApp } from "../../src/server/app/index.js";
import { CORE_MIGRATIONS, migrate } from "../../src/server/db/index.js";
import type { Events } from "../../src/server/events/index.js";
import { openTestDatabase, ORG_A } from "../db/test-database.js";
import type { TestDatabase } from "../db/test-database.js";
import { createTestEvents } from "../events/test-events.js";
import { createTestApp } from "../server/app.js";
import type { LogCapture } from "../server/log-capture.js";

export const HUB_URL = "https://hub.example.com";
export const OWNER_EMAIL = "ann@acme.dev";
export const OWNER_PASSWORD = "correct horse battery";
export const OWNER_ID = "a0000000-0000-4000-8000-000000000001";
export const MEMBER_EMAIL = "bob@acme.dev";
export const MEMBER_ID = "a0000000-0000-4000-8000-000000000002";

/** The access plugin with its real session resolver over a migrated database with one organization and two users. */
export interface SessionApp {
  app: HubApp;
  test: TestDatabase;
  /** The bus and streams the routes use. */
  events: Events;
  log: LogCapture;
  /** A request as the hub's own origin unless `headers` say otherwise. */
  send: (request: InjectOptions) => Promise<LightMyRequestResponse>;
  /** Logs in and answers the cookie to send back, as `name=value`. */
  login: (email?: string, password?: string) => Promise<string>;
  close: () => Promise<void>;
}

/** What a test may choose: the public URL, and an app without the seeded users. */
export interface SessionAppOptions {
  publicUrl?: string;
  /** Skips the seeded users, for tests of the setup. */
  isEmpty?: boolean;
}

// The same hash for every test of the file: scrypt at the hub's parameters takes a few hundred milliseconds
const hashes = new Map<string, Promise<string>>();
const hashOf = async (password: string): Promise<string> => {
  const cached = hashes.get(password) ?? createPasswordHasher().hash(password);
  hashes.set(password, cached);
  return await cached;
};

const seed = async (test: TestDatabase): Promise<void> => {
  const passwordHash = await hashOf(OWNER_PASSWORD);
  await test.db.system("test: add the organization and its users", async (trx) => {
    await sql`insert into orgs (id, name) values (${ORG_A}, 'Acme')`.execute(trx);
    await sql`insert into users (id, email, name, password_hash) values
      (${OWNER_ID}, ${OWNER_EMAIL}, 'Ann', ${passwordHash}),
      (${MEMBER_ID}, ${MEMBER_EMAIL}, 'Bob', ${passwordHash})`.execute(trx);
    await sql`insert into memberships (user_id, org_id, role) values
      (${OWNER_ID}, ${ORG_A}, 'owner'), (${MEMBER_ID}, ${ORG_A}, 'member')`.execute(trx);
  });
};

/** The `name=value` part of the cookie a response sets, to send back. */
export const cookieOf = (response: LightMyRequestResponse): string => {
  const header = response.headers["set-cookie"];
  const text = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  return text.split(";")[0] ?? "";
};

/** Opens the test database, migrates it and adds the access plugin as the hub does, without a resolver of its own. */
export const openSessionApp = async (options: SessionAppOptions = {}): Promise<SessionApp> => {
  const publicUrl = options.publicUrl ?? HUB_URL;
  const test = await openTestDatabase();
  await migrate(
    test.db,
    { url: test.ownerUrl ?? test.url, packages: [CORE_MIGRATIONS], log: test.logger },
    new AbortController().signal,
  );
  if (options.isEmpty !== true) {
    await seed(test);
  }
  const { app, log } = createTestApp({ publicUrl });
  const events = createTestEvents();
  addAccess(app, {
    db: test.db,
    events,
    features: ["debugger"],
    entitlements: createEntitlements({ sources: [], now: Date.now }),
    publicUrl: () => publicUrl,
  });
  await app.ready();

  const send: SessionApp["send"] = async (request) =>
    await app.inject({ ...request, headers: { origin: new URL(publicUrl).origin, ...request.headers } });
  return {
    app,
    test,
    events,
    log,
    send,
    login: async (email = OWNER_EMAIL, password = OWNER_PASSWORD) =>
      cookieOf(await send({ method: "POST", url: "/api/v1/session", payload: { email, password } })),
    close: async () => {
      await app.close();
      await test.close();
    },
  };
};
