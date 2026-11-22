import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestApp } from "../../../../test/server/app.js";
import type { LogCapture } from "../../../../test/server/log-capture.js";
import type { HubApp } from "../index.js";

const apps: HubApp[] = [];

const create = (): { app: HubApp; log: LogCapture } => {
  const created = createTestApp();
  created.app.get("/healthz", () => ({ status: "ok" }));
  created.app.get("/readyz", () => ({ status: "ready" }));
  created.app.get("/api/v1/projects/:projectId", () => ({ id: "p1" }));
  created.app.post("/api/v1/projects", () => ({ id: "p1" }));
  apps.push(created.app);
  return created;
};

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

const requestLines = (log: LogCapture): Array<Record<string, unknown>> =>
  log.lines().filter((line) => typeof line.msg === "string" && line.msg.startsWith("request."));

describe("request log", () => {
  it("writes one info line with the method, route pattern, status, duration and request id", async () => {
    const { app, log } = create();

    const response = await app.inject({ url: "/api/v1/projects/p1" });

    expect(requestLines(log)).toEqual([
      expect.objectContaining({
        level: 30,
        msg: "request.completed",
        method: "GET",
        route: "/api/v1/projects/:projectId",
        statusCode: 200,
        durationMs: expect.any(Number) as unknown,
        reqId: response.headers["x-request-id"],
      }),
    ]);
  });

  it("logs a request that matched no route", async () => {
    const { app, log } = create();

    await app.inject({ url: "/api/v1/missing" });

    expect(requestLines(log)).toEqual([
      expect.objectContaining({ msg: "request.completed", route: "(unmatched)", statusCode: 404 }),
    ]);
  });

  it("logs a request with a malformed URL", async () => {
    const { app, log } = create();

    await app.inject({ url: "/api/v1/%E0" });

    expect(requestLines(log)).toEqual([
      expect.objectContaining({ msg: "request.completed", route: "(unmatched)", statusCode: 400 }),
    ]);
  });

  it("writes nothing for /healthz and /readyz", async () => {
    const { app, log } = create();

    await app.inject({ url: "/healthz" });
    await app.inject({ url: "/readyz" });

    expect(requestLines(log)).toEqual([]);
  });

  it("logs a request the client aborts before its response", async () => {
    const { app, log } = create();
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    // The body never arrives in full, so the request is still running when the client goes away
    socket.write("POST /api/v1/projects HTTP/1.1\r\nHost: hub\r\nContent-Type: application/json\r\n");
    socket.write("Content-Length: 100\r\n\r\n{");
    socket.destroy();

    await vi.waitFor(() => {
      expect(requestLines(log)).toEqual([
        expect.objectContaining({ msg: "request.aborted", method: "POST", route: "/api/v1/projects" }),
      ]);
    });
  });
});
