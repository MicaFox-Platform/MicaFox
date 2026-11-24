import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openSessionApp } from "../../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../../test/access/session-app.js";

let hub: SessionApp;

afterEach(async () => {
  vi.useRealTimers();
  await hub.close();
});

type Route = "setup" | "login" | "password";

const ROUTES: Record<Route, { method: "POST" | "PUT"; url: string }> = {
  setup: { method: "POST", url: "/api/v1/setup" },
  login: { method: "POST", url: "/api/v1/session" },
  password: { method: "PUT", url: "/api/v1/me/password" },
};

// An empty body fails validation after the limit has counted it, so a test spends no scrypt time on its attempts
const attempt = async (route: Route, cookie?: string): Promise<LightMyRequestResponse> =>
  await hub.send({ ...ROUTES[route], payload: {}, headers: cookie === undefined ? {} : { cookie } });

const attemptTimes = async (route: Route, times: number, cookie?: string): Promise<void> => {
  await Promise.all(Array.from({ length: times }, async () => await attempt(route, cookie)));
};

const loginFrom = async (remoteAddress: string): Promise<LightMyRequestResponse> =>
  await hub.send({ ...ROUTES.login, payload: {}, remoteAddress });

const loginTimesFrom = async (remoteAddress: string, times: number): Promise<void> => {
  await Promise.all(Array.from({ length: times }, async () => await loginFrom(remoteAddress)));
};

describe("the limit per IP", () => {
  it.each(["setup", "login"] as const)(
    "answers the 101st %s attempt in 10 minutes 429 rate-limited with Retry-After and no other rate header",
    async (route) => {
      hub = await openSessionApp();
      await attemptTimes(route, 100);

      const response = await attempt(route);

      expect([
        response.statusCode,
        response.json<{ type: string }>().type,
        Number(response.headers["retry-after"]) > 590,
        Object.keys(response.headers).filter((name) => name.includes("ratelimit")),
      ]).toEqual([429, "urn:micafox:problem:rate-limited", true, []]);
    },
  );

  it("limits a password change, which proves the limit sees routes behind the actor hook", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await attemptTimes("password", 100, cookie);

    const response = await attempt("password", cookie);

    expect(response.statusCode).toBe(429);
  });

  it("counts each route on its own", async () => {
    hub = await openSessionApp();
    await attemptTimes("setup", 100);

    const response = await attempt("login");

    expect(response.statusCode).toBe(400);
  });

  it("counts each IP on its own", async () => {
    hub = await openSessionApp();
    await loginTimesFrom("203.0.113.5", 101);

    const response = await loginFrom("203.0.113.6");

    expect(response.statusCode).toBe(400);
  });

  it("counts the IPv6 addresses of one /64 together and another /64 apart", async () => {
    hub = await openSessionApp();
    await loginTimesFrom("2001:db8:1:1::1", 100);

    const [sameSubnet, otherSubnet] = [await loginFrom("2001:db8:1:1::2"), await loginFrom("2001:db8:1:2::1")];

    expect([sameSubnet.statusCode, otherSubnet.statusCode]).toEqual([429, 400]);
  });

  it("lets an IP try again once its 10 minutes are over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    hub = await openSessionApp();
    await attemptTimes("login", 101);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);

    const response = await attempt("login");

    expect(response.statusCode).toBe(400);
  });

  it("does not limit the routes without a secret to check", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await Promise.all(
      Array.from({ length: 101 }, async () => await hub.send({ url: "/api/v1/session", headers: { cookie } })),
    );

    const response = await hub.send({ url: "/api/v1/session", headers: { cookie } });

    expect(response.statusCode).toBe(200);
  });
});
