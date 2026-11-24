import { afterEach, describe, expect, it } from "vitest";

import { MEMBER_EMAIL, OWNER_EMAIL, OWNER_PASSWORD, openSessionApp } from "../../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../../test/access/session-app.js";

let hub: SessionApp;

afterEach(async () => {
  await hub.close();
});

const attempt = async (email: string, password: string): Promise<Awaited<ReturnType<SessionApp["send"]>>> =>
  await hub.send({ method: "POST", url: "/api/v1/session", payload: { email, password } });

const wrongPasswordFor = async (email: string, times: number): Promise<void> => {
  for (let count = 0; count < times; count += 1) {
    await attempt(email, "wrong password!");
  }
};

describe("login rate limits", () => {
  it("answers 429 rate-limited with Retry-After after 5 failures for one email, even with the right password", async () => {
    hub = await openSessionApp();
    await wrongPasswordFor(OWNER_EMAIL, 5);

    const response = await attempt(OWNER_EMAIL, OWNER_PASSWORD);

    expect([response.statusCode, response.json<{ type: string }>().type, response.headers["retry-after"]]).toEqual([
      429,
      "urn:micafox:problem:rate-limited",
      "1",
    ]);
  });

  it("does not slow another email, which stays at 200", async () => {
    hub = await openSessionApp();
    await wrongPasswordFor(OWNER_EMAIL, 5);

    const response = await attempt(MEMBER_EMAIL, OWNER_PASSWORD);

    expect(response.statusCode).toBe(200);
  });

  it("counts failures of an email that has no account, so the 429 never says which emails exist", async () => {
    hub = await openSessionApp();
    await wrongPasswordFor("nobody@acme.dev", 5);

    const response = await attempt("nobody@acme.dev", "wrong password!");

    expect([response.statusCode, response.headers["retry-after"]]).toEqual([429, "1"]);
  });

  it("lets at most 5 of 10 parallel wrong logins for one email reach the password check", async () => {
    hub = await openSessionApp();

    const responses = await Promise.all(
      Array.from({ length: 10 }, async () => await attempt(OWNER_EMAIL, "wrong password!")),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect([
      statuses.filter((status) => status === 401).length,
      statuses.filter((status) => status === 429).length,
    ]).toEqual([5, 5]);
  });

  it("answers 429 after 100 attempts from one IP in 10 minutes, whatever the email", async () => {
    hub = await openSessionApp();
    await Promise.all(
      Array.from(
        { length: 100 },
        async (_value, index) => await attempt(`user${String(index)}@acme.dev`, "wrong password!"),
      ),
    );

    const response = await attempt(MEMBER_EMAIL, OWNER_PASSWORD);

    expect([response.statusCode, Number(response.headers["retry-after"]) > 0]).toEqual([429, true]);
  });
});

describe("login log lines", () => {
  it("logs a login and a failed login as info lines with an event, and no password, cookie or token", async () => {
    hub = await openSessionApp();
    const password = "hunter2 hunter2 hunter2";
    await attempt(OWNER_EMAIL, password);
    const cookie = await hub.login();

    const lines = hub.log.lines().filter((line) => typeof line.event === "string");

    expect(lines.map((line) => [line.level, line.event])).toEqual([
      [30, "auth.login-failed"],
      [30, "auth.login"],
    ]);
    expect(
      [password, cookie.split("=")[1] ?? "", OWNER_PASSWORD].filter((secret) => hub.log.text().includes(secret)),
    ).toEqual([]);
  });

  it("logs a password change without the passwords", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await hub.send({
      method: "PUT",
      url: "/api/v1/me/password",
      headers: { cookie },
      payload: { currentPassword: OWNER_PASSWORD, newPassword: "a brand new passphrase" },
    });

    const events = hub.log.lines().map((line) => line.event);

    expect([events.includes("auth.password-changed"), hub.log.text().includes("a brand new passphrase")]).toEqual([
      true,
      false,
    ]);
  });
});
