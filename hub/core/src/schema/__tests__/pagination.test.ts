import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { pageOf, pageQueryProperties } from "../index.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

interface List {
  app: FastifyInstance;
  /** The queries as the handler saw them, after defaults and coercion; kept on the server, never echoed back. */
  seenQueries: unknown[];
}

// A list as a route declares it, under Fastify's own validator: the page parameters beside a filter of its own
const createList = (nextCursor?: string): List => {
  const app = fastify();
  const seenQueries: unknown[] = [];
  app.get(
    "/instances",
    {
      schema: {
        querystring: Type.Object({ ...pageQueryProperties, online: Type.Optional(Type.Boolean()) }),
        response: { 200: pageOf(Type.Object({ id: Type.String() })) },
      },
    },
    () => ({
      items: [{ id: "i1", hostname: "web-1" }],
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  );
  app.get(
    "/query",
    { schema: { querystring: Type.Object({ ...pageQueryProperties, online: Type.Optional(Type.Boolean()) }) } },
    (request) => {
      seenQueries.push(request.query);
      return { ok: true };
    },
  );
  apps.push(app);
  return { app, seenQueries };
};

describe("pageQueryProperties", () => {
  it("defaults the limit to 50", async () => {
    const { app, seenQueries } = createList();

    await app.inject({ url: "/query" });

    expect(seenQueries).toEqual([{ limit: 50 }]);
  });

  it("takes a limit from 1 to 200, a cursor and the list's own filters", async () => {
    const { app, seenQueries } = createList();

    await app.inject({ url: "/query?limit=200&cursor=c2&online=true" });

    expect(seenQueries).toEqual([{ limit: 200, cursor: "c2", online: true }]);
  });

  it.each(["0", "201", "1.5", "many"])("rejects the limit %s", async (limit) => {
    const { app, seenQueries } = createList();

    const response = await app.inject({ url: `/query?limit=${limit}` });

    expect(response.statusCode).toBe(400);
    expect(seenQueries).toEqual([]);
  });

  it("rejects an empty cursor and one over 512 characters", async () => {
    const { app, seenQueries } = createList();

    const responses = await Promise.all([
      app.inject({ url: "/query?cursor=" }),
      app.inject({ url: `/query?cursor=${"c".repeat(513)}` }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([400, 400]);
    expect(seenQueries).toEqual([]);
  });
});

describe("pageOf", () => {
  it("answers the items and the next cursor, without fields the item schema does not list", async () => {
    const response = await createList("c2").app.inject({ url: "/instances" });

    expect(response.json()).toEqual({ items: [{ id: "i1" }], nextCursor: "c2" });
  });

  it("leaves out nextCursor on the last page", async () => {
    const response = await createList().app.inject({ url: "/instances" });

    expect(response.json()).toEqual({ items: [{ id: "i1" }] });
  });
});
