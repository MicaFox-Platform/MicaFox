# 0041. Accept SDK WebSockets with @fastify/websocket

## Status

Accepted · 2026-11-25

## Context

Every SDK connector opens one WebSocket to `GET /sdk` on the hub
([ADR 0008](../../protocol/0008-use-websocket-for-the-hub-connection.md)). Before the upgrade the hub checks the
project key and its limits and refuses with an HTTP problem (401, 403, 429, 503), as every other route of the hub
answers through Fastify ([ADR 0025](../server/0025-build-the-hub-server-on-fastify-with-typebox-schemas.md)). Until
now `@micafox/hub-core` had no WebSocket server. The SDK uses `ws`, which has no dependencies of its own.

## Decision

We use `@fastify/websocket`, the Fastify team's plugin over `ws`, so `/sdk` is a Fastify route: its key check runs as
a route hook before the upgrade, and its refusals use the hub's problem documents and request log.

## Alternatives

- **`ws` alone on the server's `upgrade` event** — one dependency fewer, but the key check, the problem documents,
  the request ids and the readiness gate would be written a second time outside Fastify, on a raw socket.
- **Node's own WebSocket** — Node ships only a client, not a server.

## Consequences

- `@fastify/websocket` and its three small dependencies (`ws`, `duplexify`, `fastify-plugin`) become runtime
  dependencies of `@micafox/hub-core`.
- The plugin sends every upgrade through Fastify's routing: the hub answers an upgrade to any route but `/sdk` over
  HTTP and closes its socket, so no upgraded socket outlives its answer.
- The hub sets the plugin's close and error handling itself: on stop it cuts off what did not close, and a peer's
  socket error is a debug line, not an error.
- `/sdk` has no limit per IP, unlike the routes of [ADR 0040](../access/0040-limit-attempts-per-ip-with-fastify-rate-limit.md):
  a fleet of apps often connects from one NAT address, and a project key is 256 random bits, refused without a
  database query unless it has the key's format. The connection limits per replica and per key bound the load.
