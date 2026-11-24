import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  HUB_URL,
  MEMBER_EMAIL,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  cookieOf,
  openSessionApp,
} from "../../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../../test/access/session-app.js";
import { hashToken } from "../../tokens/index.js";

let hub: SessionApp;

afterEach(async () => {
  await hub.close();
});

const login = async (): Promise<Awaited<ReturnType<SessionApp["send"]>>> =>
  await hub.send({ method: "POST", url: "/api/v1/session", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });

describe("the session cookie", () => {
  it("is __Host-micafox_session, HttpOnly, Secure, SameSite=Lax and Path=/ on an https hub", async () => {
    hub = await openSessionApp();

    const response = await login();

    expect(response.headers["set-cookie"]).toMatch(
      /^__Host-micafox_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/,
    );
  });

  it("is micafox_session without Secure on http://localhost", async () => {
    hub = await openSessionApp({ publicUrl: "http://localhost:8080" });

    const response = await login();

    expect(response.headers["set-cookie"]).toMatch(
      /^micafox_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
  });

  it("holds 32 random bytes of which the database stores only the SHA-256", async () => {
    hub = await openSessionApp();

    const cookie = cookieOf(await login());

    const stored = await sql<{ tokenHash: string }>`select token_hash as "tokenHash" from sessions`.execute(
      hub.test.db.global,
    );
    expect(stored.rows).toEqual([{ tokenHash: hashToken(cookie.split("=")[1] ?? "") }]);
  });

  it("is not accepted under the other name, so a cookie of a sibling site cannot stand in", async () => {
    hub = await openSessionApp();
    const cookie = cookieOf(await login());

    const response = await hub.send({
      url: "/api/v1/session",
      headers: { cookie: cookie.replace("__Host-micafox_session", "micafox_session") },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("the origin check", () => {
  // A route of each changing method; the check runs before the route, so the body and the ids need not be valid
  it.each([
    ["POST", "/api/v1/session"],
    ["PUT", "/api/v1/me/password"],
    ["PATCH", "/api/v1/projects/0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01"],
    ["DELETE", "/api/v1/sessions"],
  ] as const)("refuses a %s with the cookie and a foreign Origin", async (method, url) => {
    hub = await openSessionApp();
    const cookie = cookieOf(await login());

    const response = await hub.send({
      method,
      url,
      headers: { cookie, origin: "https://evil.example" },
    });

    expect([response.statusCode, response.json<{ type: string }>().type]).toEqual([
      403,
      "urn:micafox:problem:origin-mismatch",
    ]);
  });

  it("refuses a changing request with the cookie and no Origin", async () => {
    hub = await openSessionApp();
    const cookie = cookieOf(await login());

    const response = await hub.app.inject({ method: "DELETE", url: "/api/v1/sessions", headers: { cookie } });

    expect(response.statusCode).toBe(403);
  });

  it("refuses an Origin that differs only by its port or scheme", async () => {
    hub = await openSessionApp();
    const cookie = cookieOf(await login());

    const statuses = await Promise.all(
      ["https://hub.example.com:8443", "http://hub.example.com"].map(
        async (origin) =>
          (await hub.send({ method: "DELETE", url: "/api/v1/sessions", headers: { cookie, origin } })).statusCode,
      ),
    );

    expect(statuses).toEqual([403, 403]);
  });

  it("accepts the hub's own Origin", async () => {
    hub = await openSessionApp();
    const cookie = cookieOf(await login());

    const response = await hub.send({
      method: "DELETE",
      url: "/api/v1/sessions",
      headers: { cookie, origin: HUB_URL },
    });

    expect(response.statusCode).toBe(204);
  });

  it("needs no Origin for a GET with the cookie", async () => {
    hub = await openSessionApp();
    const cookie = cookieOf(await login());

    const response = await hub.app.inject({ url: "/api/v1/session", headers: { cookie } });

    expect(response.statusCode).toBe(200);
  });

  it("needs no Origin when the request carries no cookie", async () => {
    hub = await openSessionApp();

    const response = await hub.app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { email: MEMBER_EMAIL, password: OWNER_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
  });
});
