import { PassThrough } from "node:stream";

import type { Streams } from "./streams.js";
import type { HubApp } from "../app/index.js";

/**
 * `GET /api/internal/events`, for the web app: a server-sent events stream of the events of the organizations the
 * session's user belongs to, which starts with `reset`. It goes in the scope that has the actor, so a request
 * without a session is 401. The reply is a stream, not a hijacked socket, so the app's hooks still set the
 * security headers and log the request, which ends with the stream.
 */
export const addEventsRoute = (app: HubApp, streams: Streams): void => {
  app.get("/api/internal/events", async (request, reply) => {
    const { userId, memberships } = request.actor;
    const body = new PassThrough();
    const stream = streams.open({
      userId,
      orgIds: new Set(memberships.map((membership) => membership.orgId)),
      sink: {
        write: (chunk) => body.write(chunk),
        end: () => {
          body.end();
        },
      },
    });
    body.on("drain", stream.onDrain);
    // The client went away, or the stream broke: either way there is nobody to write to
    body.on("close", stream.end);
    body.on("error", stream.end);
    void reply.headers({ "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    return await reply.send(body);
  });
};
