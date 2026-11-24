import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openSessionApp } from "../../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../../test/access/session-app.js";

let hub: SessionApp;

afterEach(async () => {
  await hub.close();
});

// Moves the time a session began and was last used back by the given SQL intervals
const age = async (intervals: { createdAgo: string; usedAgo: string }): Promise<void> => {
  await sql`update sessions set
    created_at = now() - ${intervals.createdAgo}::interval,
    last_used_at = now() - ${intervals.usedAgo}::interval`.execute(hub.test.db.global);
};

const lastUse = async (): Promise<number> => {
  const result = await sql<{ at: Date }>`select last_used_at as at from sessions`.execute(hub.test.db.global);
  return result.rows[0]?.at.getTime() ?? 0;
};

const statusWith = async (cookie: string): Promise<{ status: number; type: string | undefined }> => {
  const response = await hub.send({ url: "/api/v1/session", headers: { cookie } });
  return {
    status: response.statusCode,
    type: response.statusCode === 200 ? undefined : response.json<{ type: string }>().type,
  };
};

describe("the session resolver", () => {
  it("accepts a session used 6 days ago and begun 29 days ago", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await age({ createdAgo: "29 days", usedAgo: "6 days" });

    expect(await statusWith(cookie)).toEqual({ status: 200, type: undefined });
  });

  it("answers 401 session-expired for a session unused for more than 7 days", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await age({ createdAgo: "9 days", usedAgo: "8 days" });

    expect(await statusWith(cookie)).toEqual({ status: 401, type: "urn:micafox:problem:session-expired" });
  });

  it("answers 401 session-expired for a session older than 30 days, however recently it was used", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await age({ createdAgo: "31 days", usedAgo: "1 minute" });

    expect(await statusWith(cookie)).toEqual({ status: 401, type: "urn:micafox:problem:session-expired" });
  });

  it("does not refresh the last use of an expired session", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await age({ createdAgo: "31 days", usedAgo: "1 minute" });
    const before = await lastUse();

    await statusWith(cookie);

    expect(await lastUse()).toBe(before);
  });

  it("writes the last use when it is older than a minute", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await age({ createdAgo: "1 day", usedAgo: "2 minutes" });
    const before = await lastUse();

    await statusWith(cookie);

    expect(await lastUse()).toBeGreaterThan(before);
  });

  it("does not write the last use again within a minute", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await age({ createdAgo: "1 day", usedAgo: "10 seconds" });
    const before = await lastUse();

    await statusWith(cookie);

    expect(await lastUse()).toBe(before);
  });

  it("stops a removed member at their next request", async () => {
    hub = await openSessionApp();
    const cookie = await hub.login();
    await sql`delete from memberships`.execute(hub.test.db.global);

    const response = await hub.send({
      url: "/api/v1/orgs/0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01/projects",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});
