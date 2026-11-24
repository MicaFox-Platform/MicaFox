import type { LightMyRequestResponse } from "fastify";
import { sql } from "kysely";
import { scryptSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  MEMBER_EMAIL,
  MEMBER_ID,
  OWNER_EMAIL,
  OWNER_ID,
  OWNER_PASSWORD,
  openSessionApp,
} from "../../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../../test/access/session-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";

let hub: SessionApp;

afterEach(async () => {
  await hub.close();
});

const problemOf = (response: LightMyRequestResponse): string => response.json<{ type: string }>().type;

const sessionCount = async (): Promise<number> => {
  const result = await sql<{ count: string }>`select count(*)::text as count from sessions`.execute(hub.test.db.global);
  return Number(result.rows[0]?.count);
};

describe("POST /api/v1/session", () => {
  it("logs in with an email of any case and answers the user and their organizations", async () => {
    hub = await openSessionApp();

    const response = await hub.send({
      method: "POST",
      url: "/api/v1/session",
      payload: { email: "ANN@acme.dev", password: OWNER_PASSWORD },
    });

    expect([response.statusCode, response.json()]).toEqual([
      200,
      {
        user: { id: OWNER_ID, name: "Ann", email: OWNER_EMAIL },
        memberships: [{ orgId: ORG_A, orgName: "Acme", role: "owner" }],
      },
    ]);
  });

  it("answers 401 invalid-credentials for a wrong password", async () => {
    hub = await openSessionApp();

    const response = await hub.send({
      method: "POST",
      url: "/api/v1/session",
      payload: { email: OWNER_EMAIL, password: "wrong password!" },
    });

    expect([response.statusCode, problemOf(response), response.headers["retry-after"]]).toEqual([
      401,
      "urn:micafox:problem:invalid-credentials",
      undefined,
    ]);
  });

  it("answers an unknown email with the same 401 as a wrong password, with the same body but for the request id", async () => {
    hub = await openSessionApp();
    const [unknown, wrong] = await Promise.all([
      hub.send({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "nobody@acme.dev", password: "wrong password!" },
      }),
      hub.send({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: OWNER_EMAIL, password: "wrong password!" },
      }),
    ]);

    const withoutId = (body: Record<string, unknown>): Record<string, unknown> => ({ ...body, requestId: undefined });
    expect([unknown.statusCode, withoutId(unknown.json())]).toEqual([wrong.statusCode, withoutId(wrong.json())]);
  });

  it("does not set a cookie when the login fails", async () => {
    hub = await openSessionApp();

    const response = await hub.send({
      method: "POST",
      url: "/api/v1/session",
      payload: { email: OWNER_EMAIL, password: "wrong password!" },
    });

    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("replaces a hash with weaker parameters by one with the current parameters on success", async () => {
    hub = await openSessionApp();
    const salt = Buffer.alloc(16, 7);
    const key = scryptSync(OWNER_PASSWORD, salt, 32, { cost: 2 ** 14, blockSize: 8, parallelization: 1 });
    const weak = ["scrypt", "16384", "8", "1", salt.toString("base64url"), key.toString("base64url")].join("$");
    await sql`update users set password_hash = ${weak} where id = ${OWNER_ID}`.execute(hub.test.db.global);

    const response = await hub.send({
      method: "POST",
      url: "/api/v1/session",
      payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });

    const stored = await sql<{ hash: string }>`select password_hash as hash from users where id = ${OWNER_ID}`.execute(
      hub.test.db.global,
    );
    expect([response.statusCode, stored.rows[0]?.hash.startsWith("scrypt$32768$8$3$")]).toEqual([200, true]);
  });
});

describe("GET /api/v1/session", () => {
  it("answers 401 unauthenticated without a cookie", async () => {
    hub = await openSessionApp();

    const response = await hub.send({ url: "/api/v1/session" });

    expect([response.statusCode, problemOf(response)]).toEqual([401, "urn:micafox:problem:unauthenticated"]);
  });

  it("answers 401 unauthenticated for a cookie the hub did not give", async () => {
    hub = await openSessionApp();

    const response = await hub.send({
      url: "/api/v1/session",
      headers: { cookie: "__Host-micafox_session=bm90LWEtcmVhbC1zZXNzaW9u" },
    });

    expect(problemOf(response)).toBe("urn:micafox:problem:unauthenticated");
  });

  it("answers the user of the cookie", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login(MEMBER_EMAIL);

    const response = await hub.send({ url: "/api/v1/session", headers: { cookie } });

    expect(response.json()).toEqual({
      user: { id: MEMBER_ID, name: "Bob", email: MEMBER_EMAIL },
      memberships: [{ orgId: ORG_A, orgName: "Acme", role: "member" }],
    });
  });

  it("lets the session reach the routes of its organization", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login(MEMBER_EMAIL);

    const response = await hub.send({ url: `/api/v1/orgs/${ORG_A}/projects`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
  });
});

describe("DELETE /api/v1/session", () => {
  it("ends the session of the cookie only and clears the cookie", async () => {
    hub = await openSessionApp();
    const [first, second] = [await hub.login(), await hub.login()];

    const response = await hub.send({ method: "DELETE", url: "/api/v1/session", headers: { cookie: first } });

    const [afterFirst, afterSecond] = await Promise.all([
      hub.send({ url: "/api/v1/session", headers: { cookie: first } }),
      hub.send({ url: "/api/v1/session", headers: { cookie: second } }),
    ]);
    expect([
      response.statusCode,
      response.headers["set-cookie"],
      afterFirst.statusCode,
      afterSecond.statusCode,
    ]).toEqual([204, "__Host-micafox_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure", 401, 200]);
  });
});

describe("DELETE /api/v1/session with an expired session", () => {
  it("answers 401 session-expired, so the web app goes to the login page", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await sql`update sessions set created_at = now() - interval '31 days'`.execute(hub.test.db.global);

    const response = await hub.send({ method: "DELETE", url: "/api/v1/session", headers: { cookie } });

    expect([response.statusCode, problemOf(response)]).toEqual([401, "urn:micafox:problem:session-expired"]);
  });
});

describe("DELETE /api/v1/sessions", () => {
  it("ends every session of the user and none of another", async () => {
    hub = await openSessionApp();
    const [first, second, other] = [await hub.login(), await hub.login(), await hub.login(MEMBER_EMAIL)];

    await hub.send({ method: "DELETE", url: "/api/v1/sessions", headers: { cookie: first } });

    const statuses = await Promise.all(
      [first, second, other].map(
        async (cookie) => (await hub.send({ url: "/api/v1/session", headers: { cookie } })).statusCode,
      ),
    );
    expect(statuses).toEqual([401, 401, 200]);
  });
});

describe("PUT /api/v1/me/password", () => {
  it("changes the password, ends the other sessions and keeps the current one", async () => {
    hub = await openSessionApp();
    const [current, other] = [await hub.login(), await hub.login()];

    const response = await hub.send({
      method: "PUT",
      url: "/api/v1/me/password",
      headers: { cookie: current },
      payload: { currentPassword: OWNER_PASSWORD, newPassword: "a brand new passphrase" },
    });

    const [afterCurrent, afterOther, oldLogin, newLogin] = await Promise.all([
      hub.send({ url: "/api/v1/session", headers: { cookie: current } }),
      hub.send({ url: "/api/v1/session", headers: { cookie: other } }),
      hub.send({ method: "POST", url: "/api/v1/session", payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD } }),
      hub.send({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: OWNER_EMAIL, password: "a brand new passphrase" },
      }),
    ]);
    expect([
      response.statusCode,
      afterCurrent.statusCode,
      afterOther.statusCode,
      oldLogin.statusCode,
      newLogin.statusCode,
    ]).toEqual([204, 200, 401, 401, 200]);
  });

  it("answers 401 invalid-credentials and changes nothing when the current password is wrong", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();

    const response = await hub.send({
      method: "PUT",
      url: "/api/v1/me/password",
      headers: { cookie },
      payload: { currentPassword: "not my password", newPassword: "a brand new passphrase" },
    });

    const login = await hub.send({
      method: "POST",
      url: "/api/v1/session",
      payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    expect([response.statusCode, problemOf(response), login.statusCode]).toEqual([
      401,
      "urn:micafox:problem:invalid-credentials",
      200,
    ]);
  });

  it("counts a wrong current password toward the email's failures, so guessing it is throttled too", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    const change = async (currentPassword: string): Promise<LightMyRequestResponse> =>
      await hub.send({
        method: "PUT",
        url: "/api/v1/me/password",
        headers: { cookie },
        payload: { currentPassword, newPassword: "a brand new passphrase" },
      });
    for (const guess of ["guess one", "guess two", "guess three", "guess four", "guess five"]) {
      await change(guess);
    }

    const response = await change(OWNER_PASSWORD);

    expect([response.statusCode, response.headers["retry-after"]]).toEqual([429, "1"]);
  });

  it("answers 400 validation for a new password shorter than 12 characters", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();

    const response = await hub.send({
      method: "PUT",
      url: "/api/v1/me/password",
      headers: { cookie },
      payload: { currentPassword: OWNER_PASSWORD, newPassword: "short" },
    });

    expect([response.statusCode, problemOf(response)]).toEqual([400, "urn:micafox:problem:validation"]);
  });

  it("keeps the session count of a rejected change", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await hub.login();

    await hub.send({
      method: "PUT",
      url: "/api/v1/me/password",
      headers: { cookie },
      payload: { currentPassword: "not my password", newPassword: "a brand new passphrase" },
    });

    expect(await sessionCount()).toBe(2);
  });
});
