import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApp } from "../../../../test/server/app.js";
import type { AppOptions, HubApp } from "../index.js";

const apps: HubApp[] = [];

const create = (options: Partial<Omit<AppOptions, "logger">> = {}): HubApp => {
  const { app } = createTestApp(options);
  apps.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

const ipSeenBy = async (trustProxy: AppOptions["trustProxy"]): Promise<string> => {
  const app = create({ trustProxy });
  app.get("/ip", (request) => request.ip);

  const response = await app.inject({
    url: "/ip",
    remoteAddress: "10.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" },
  });
  return response.body;
};

describe("createApp trust proxy", () => {
  it("believes no forwarded header by default", async () => {
    await expect(ipSeenBy(false)).resolves.toBe("10.0.0.1");
  });

  it("believes every proxy when true", async () => {
    await expect(ipSeenBy(true)).resolves.toBe("203.0.113.7");
  });

  it("believes the given number of hops", async () => {
    await expect(ipSeenBy(1)).resolves.toBe("10.0.0.2");
    await expect(ipSeenBy(2)).resolves.toBe("203.0.113.7");
  });

  it("believes proxies listed by address or CIDR", async () => {
    await expect(ipSeenBy(["10.0.0.0/8"])).resolves.toBe("203.0.113.7");
    await expect(ipSeenBy(["192.168.0.1"])).resolves.toBe("10.0.0.1");
  });

  it("takes the protocol and host from a trusted proxy only", async () => {
    const trusting = create({ trustProxy: ["10.0.0.0/8"] });
    const doubting = create({ trustProxy: false });
    const route = (app: HubApp): void => {
      app.get("/origin", (request) => `${request.protocol}://${request.host}`);
    };
    route(trusting);
    route(doubting);
    const request = {
      url: "/origin",
      remoteAddress: "10.0.0.1",
      headers: { host: "10.0.0.5:8080", "x-forwarded-proto": "https", "x-forwarded-host": "hub.example.com" },
    };

    const [trusted, doubted] = await Promise.all([trusting.inject(request), doubting.inject(request)]);

    expect([trusted.body, doubted.body]).toEqual(["https://hub.example.com", "http://10.0.0.5:8080"]);
  });
});

describe("createApp request id", () => {
  it("gives every request its own UUID, echoed in x-request-id", async () => {
    const app = create();
    app.get("/id", (request) => request.id);

    const [first, second] = await Promise.all([app.inject({ url: "/id" }), app.inject({ url: "/id" })]);

    expect(first.headers["x-request-id"]).toBe(first.body);
    expect(first.body).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/);
    expect(second.body).not.toBe(first.body);
  });

  it("ignores an x-request-id sent by the client", async () => {
    const app = create();
    app.get("/id", (request) => request.id);

    const response = await app.inject({ url: "/id", headers: { "x-request-id": "chosen-by-client" } });

    expect(response.headers["x-request-id"]).not.toBe("chosen-by-client");
  });
});

describe("createApp schemas", () => {
  it("drops every field the response schema does not list", async () => {
    const app = create();
    app.get(
      "/user",
      { schema: { response: { 200: Type.Object({ id: Type.String(), name: Type.String() }) } } },
      // A row with more columns than the API shows, as a database query returns it
      () => ({ id: "u1", name: "Ann", passwordHash: "$argon2id$v=19$..." }),
    );

    const response = await app.inject({ url: "/user" });

    expect(response.json()).toEqual({ id: "u1", name: "Ann" });
  });
});
