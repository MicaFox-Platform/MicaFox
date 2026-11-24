import { sql } from "kysely";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { HUB_URL, cookieOf, openSessionApp } from "../../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../../test/access/session-app.js";
import { ensureSetupToken } from "../index.js";

let hub: SessionApp;

afterEach(async () => {
  await hub.close();
});

const body = (token: string): Record<string, string> => ({
  token,
  orgName: "Acme",
  name: "Ann",
  email: "ann@acme.dev",
  password: "correct horse battery",
});

// A fresh hub with its setup token, which a test reads from the log as the operator would
const openFreshHub = async (): Promise<string> => {
  hub = await openSessionApp({ isEmpty: true });
  await ensureSetupToken({
    db: hub.test.db,
    log: pino({}, hub.log.stream),
    publicUrl: () => HUB_URL,
    configuredToken: undefined,
  });
  return /mfx_setup_[\w-]{43}/.exec(hub.log.text())?.[0] ?? "";
};

const setup = async (payload: Record<string, unknown>): Promise<Awaited<ReturnType<SessionApp["send"]>>> =>
  await hub.send({ method: "POST", url: "/api/v1/setup", payload });

const count = async (table: "orgs" | "users" | "memberships" | "credentials"): Promise<number> => {
  const result = await sql<{ total: string }>`select count(*)::text as total from ${sql.table(table)}`.execute(
    hub.test.db.global,
  );
  return Number(result.rows[0]?.total);
};

describe("POST /api/v1/setup", () => {
  it("creates the organization, the owner and a session, and answers 201 with the session's body", async () => {
    const token = await openFreshHub();

    const response = await setup(body(token));

    expect([response.statusCode, response.json<{ memberships: unknown }>().memberships]).toEqual([
      201,
      [expect.objectContaining({ orgName: "Acme", role: "owner" })],
    ]);
  });

  it("sets a cookie that logs the owner in", async () => {
    const token = await openFreshHub();
    const cookie = cookieOf(await setup(body(token)));

    const response = await hub.send({ url: "/api/v1/session", headers: { cookie } });

    expect(response.json<{ user: { email: string } }>().user.email).toBe("ann@acme.dev");
  });

  it("lets the owner log in with the password they set", async () => {
    const token = await openFreshHub();
    await setup(body(token));

    const cookie = await hub.login("ann@acme.dev", "correct horse battery");

    expect(cookie).toMatch(/^__Host-micafox_session=/);
  });

  it("lets the owner log in with their email in another case than they set it up with", async () => {
    const token = await openFreshHub();
    await setup({ ...body(token), email: "Ann@Acme.dev" });

    const cookie = await hub.login("ann@acme.dev", "correct horse battery");

    expect(cookie).toMatch(/^__Host-micafox_session=/);
  });

  it("deletes the token, and answers 404 from then on, even for the right token", async () => {
    const token = await openFreshHub();
    await setup(body(token));

    const again = await setup(body(token));

    expect([again.statusCode, await count("credentials"), await count("orgs")]).toEqual([404, 0, 1]);
  });

  it("answers 403 forbidden for a wrong token and creates nothing", async () => {
    await openFreshHub();

    const response = await setup(body("mfx_setup_not-the-token"));

    expect([response.statusCode, response.json<{ type: string }>().type, await count("users")]).toEqual([
      403,
      "urn:micafox:problem:forbidden",
      0,
    ]);
  });

  it("counts wrong tokens toward the IP's rate limit", async () => {
    await openFreshHub();
    await Promise.all(Array.from({ length: 100 }, async () => await setup(body("mfx_setup_wrong"))));

    const response = await setup(body("mfx_setup_wrong"));

    expect(response.statusCode).toBe(429);
  });

  it("lets only one of two requests with the right token claim the hub", async () => {
    const token = await openFreshHub();

    const responses = await Promise.all([setup(body(token)), setup(body(token))]);

    expect([responses.map((response) => response.statusCode).sort(), await count("memberships")]).toEqual([
      [201, 403],
      1,
    ]);
  });

  it("answers 400 for a password shorter than 12 characters", async () => {
    const token = await openFreshHub();

    const response = await setup({ ...body(token), password: "short" });

    expect(response.statusCode).toBe(400);
  });

  it("names orgName when the organization's name is not valid", async () => {
    const token = await openFreshHub();

    const response = await setup({ ...body(token), orgName: "   " });

    expect(response.json<{ errors: Array<{ path: string }> }>().errors[0]?.path).toBe("/orgName");
  });

  it("keeps the token and the hub unclaimed when the setup is refused for its name", async () => {
    const token = await openFreshHub();
    await setup({ ...body(token), orgName: "   " });

    const response = await setup(body(token));

    expect(response.statusCode).toBe(201);
  });

  it("logs the setup as an info line with an event and no password or token", async () => {
    const token = await openFreshHub();
    await setup(body(token));

    const lines = hub.log.lines().filter((line) => line.event === "auth.setup");

    expect([
      lines.map((line) => line.level),
      hub.log.text().split(token).length - 1,
      hub.log.text().includes("correct horse battery"),
    ]).toEqual([[30], 1, false]);
  });
});
