import http from "node:http";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openSessionApp } from "../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../test/access/session-app.js";
import { ACTORS, openTenancyApp } from "../../../../test/access/tenancy-app.js";
import type { ActorName, TenancyApp } from "../../../../test/access/tenancy-app.js";
import { ORG_A, ORG_B } from "../../../../test/db/test-database.js";
import type { HubEvent } from "../event.js";

// What a test reads of an open stream: the text so far, and whether the server ended it
interface OpenStream {
  response: IncomingMessage;
  text: () => string;
  /** Resolves once the text satisfies `isDone`; the test's own timeout ends a wait that never does. */
  until: (isDone: (text: string) => boolean) => Promise<string>;
  hasEnded: Promise<void>;
  close: () => void;
}

const connect = async (port: number, headers: Record<string, string>): Promise<OpenStream> =>
  await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/internal/events", headers }, (response) => {
      let text = "";
      const waiting = new Set<() => void>();
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        for (const check of [...waiting]) {
          check();
        }
      });
      const hasEnded = new Promise<void>((done) => {
        response.on("end", done);
        response.on("close", done);
      });
      resolve({
        response,
        text: () => text,
        until: async (isDone) =>
          await new Promise((found) => {
            const check = (): void => {
              if (isDone(text)) {
                waiting.delete(check);
                found(text);
              }
            };
            waiting.add(check);
            check();
          }),
        hasEnded,
        close: () => {
          request.destroy();
        },
      });
    });
    request.on("error", reject);
  });

const portOf = (app: { addresses: () => Array<{ port: number }> }): number => app.addresses()[0]?.port ?? 0;

const eventOf = (orgId: string, type = "project.created"): HubEvent => ({
  type,
  orgId,
  actor: { userId: ACTORS.ownerA.userId },
  data: { projectId: "project-1" },
});

const RESET = "event: reset\ndata: {}\n\n";

describe("GET /api/internal/events", () => {
  let tenancy: TenancyApp | undefined;
  let sessions: SessionApp | undefined;
  const open: OpenStream[] = [];

  afterEach(async () => {
    for (const stream of open.splice(0)) {
      stream.close();
    }
    await tenancy?.close();
    await sessions?.close();
    tenancy = undefined;
    sessions = undefined;
  });

  const listenAsTenancy = async (): Promise<TenancyApp> => {
    tenancy = await openTenancyApp();
    await tenancy.app.listen({ host: "127.0.0.1", port: 0 });
    return tenancy;
  };

  const streamAs = async (app: TenancyApp, name: ActorName): Promise<OpenStream> => {
    const stream = await connect(portOf(app.app), { "x-test-actor": name });
    open.push(stream);
    return stream;
  };

  it("answers 401 without a session", async () => {
    const { app } = await listenAsTenancy();

    const response = await app.inject({ url: "/api/internal/events" });

    expect(response.statusCode).toBe(401);
  });

  it("answers an event stream with the app's security headers and starts with reset", async () => {
    const app = await listenAsTenancy();

    const stream = await streamAs(app, "ownerA");

    expect(stream.response.headers).toMatchObject({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    expect(await stream.until((text) => text.includes(RESET))).toBe(RESET);
  });

  it("sends the events of the user's organizations after reset", async () => {
    const app = await listenAsTenancy();
    const stream = await streamAs(app, "ownerA");
    await stream.until((text) => text.includes(RESET));

    app.events.bus.publish(eventOf(ORG_A));

    expect(await stream.until((text) => text.includes("event: project.created"))).toBe(
      `${RESET}event: project.created\ndata: ${JSON.stringify(eventOf(ORG_A))}\n\n`,
    );
  });

  it("never sends organization A's events to a member of B", async () => {
    const app = await listenAsTenancy();
    const memberOfB = await streamAs(app, "ownerB");
    await memberOfB.until((text) => text.includes(RESET));

    // A's event comes first and B's second, so B's stream has passed A's by the time it holds B's
    app.events.bus.publish(eventOf(ORG_A, "key.created"));
    app.events.bus.publish(eventOf(ORG_B, "key.revoked"));

    const text = await memberOfB.until((received) => received.includes("event: key.revoked"));
    expect(text).not.toContain("key.created");
  });

  it("sends a user who belongs to two organizations the events of both", async () => {
    const app = await listenAsTenancy();
    const stream = await streamAs(app, "both");
    await stream.until((text) => text.includes(RESET));

    app.events.bus.publish(eventOf(ORG_A, "key.created"));
    app.events.bus.publish(eventOf(ORG_B, "key.revoked"));

    const text = await stream.until((received) => received.includes("event: key.revoked"));
    expect(text).toContain("event: key.created");
  });

  it("sends the events the routes publish to the stream of the organization", async () => {
    const app = await listenAsTenancy();
    const stream = await streamAs(app, "ownerA");
    await stream.until((text) => text.includes(RESET));

    await app.post("ownerA", `/api/v1/orgs/${ORG_A}/projects`, { name: "Billing" });

    const text = await stream.until((received) => received.includes("event: project.created"));
    expect(text).toContain('"type":"project.created"');
  });

  it("ends the user's streams when they log out everywhere, and no one else's", async () => {
    sessions = await openSessionApp();
    await sessions.app.listen({ host: "127.0.0.1", port: 0 });
    const ownerCookie = await sessions.login();
    const memberCookie = await sessions.login("bob@acme.dev");
    const port = portOf(sessions.app);
    const ownerStream = await connect(port, { cookie: ownerCookie });
    const memberStream = await connect(port, { cookie: memberCookie });
    open.push(ownerStream, memberStream);
    await ownerStream.until((text) => text.includes(RESET));
    await memberStream.until((text) => text.includes(RESET));

    const logout = await sessions.send({ method: "DELETE", url: "/api/v1/sessions", headers: { cookie: ownerCookie } });
    await ownerStream.hasEnded;
    // The member's stream still takes events after the owner's ended
    sessions.events.bus.publish(eventOf(ORG_A, "key.created"));

    expect(logout.statusCode).toBe(204);
    expect(await memberStream.until((text) => text.includes("event: key.created"))).toContain("key.created");
  });

  it("ends the reply when the client goes away, and logs the request", async () => {
    const app = await listenAsTenancy();
    const stream = await streamAs(app, "ownerA");
    await stream.until((text) => text.includes(RESET));

    stream.close();

    await vi.waitFor(() => {
      expect(app.log.lines()).toContainEqual(expect.objectContaining({ route: "/api/internal/events" }));
    });
  });
});
