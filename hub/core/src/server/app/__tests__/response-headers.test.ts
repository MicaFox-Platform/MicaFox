import { afterEach, describe, expect, it } from "vitest";

import { createTestApp } from "../../../../test/server/app.js";
import type { AppOptions, HubApp } from "../index.js";

const apps: HubApp[] = [];

// A route at the root, one in an encapsulated plugin as features add theirs, and one that fails
const create = (options: Partial<Omit<AppOptions, "logger">> = {}): HubApp => {
  const { app } = createTestApp(options);
  app.get("/api/v1/root", () => ({ ok: true }));
  app.get("/api/v1/broken", () => {
    throw new Error("database is down");
  });
  void app.register(
    (feature, _options, done) => {
      feature.get("/things", () => ({ ok: true }));
      done();
    },
    { prefix: "/api/v1/feature" },
  );
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

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "strict-transport-security": "max-age=31536000",
};

describe("response headers", () => {
  it.each([
    ["a route", "/api/v1/root", 200],
    ["a route in a feature plugin", "/api/v1/feature/things", 200],
    ["an unknown route", "/api/v1/missing", 404],
    ["a failing route", "/api/v1/broken", 500],
    ["a malformed URL", "/api/v1/%E0", 400],
  ])("are set on %s", async (_case, url, status) => {
    const app = create();

    const response = await app.inject({ url });

    expect(response.statusCode).toBe(status);
    expect(response.headers).toMatchObject(SECURITY_HEADERS);
    expect(response.headers["x-request-id"]).toMatch(/^[\da-f-]{36}$/);
  });

  it("leave out HSTS when the public URL is HTTP", async () => {
    const app = create({ publicUrl: "http://localhost:8080" });

    const response = await app.inject({ url: "/api/v1/root" });

    expect(response.headers).not.toHaveProperty("strict-transport-security");
  });

  it("leave out HSTS in test mode before the port is bound", async () => {
    const app = create({ publicUrl: undefined });

    const response = await app.inject({ url: "/api/v1/root" });

    expect(response.headers).not.toHaveProperty("strict-transport-security");
  });
});
