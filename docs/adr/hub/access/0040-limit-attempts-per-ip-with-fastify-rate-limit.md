# 0040. Limit attempts per IP with @fastify/rate-limit

## Status

Accepted · 2026-11-24

## Context

The routes that check a secret, the setup token or a password (`POST /api/v1/setup`, `POST /api/v1/session` and
`PUT /api/v1/me/password`), must limit how often one IP may try: 100 attempts in 10 minutes, answered with a 429
problem and `Retry-After`. A hand-written counter inside the handlers did this, but code scanning (CodeQL
`js/missing-rate-limiting`, which the repository's CI runs on every pull request) recognises only known limiters, so
the login stayed flagged as unlimited. Self-hosted hubs must need no extra service, so the counters live in memory.
The per-email backoff after 5 failures depends on the result of the password check and stays the hub's own code.

## Decision

We use `@fastify/rate-limit`, the Fastify team's plugin, with its in-memory store and a `config.rateLimit` on each of
those routes, and answer its limit with the hub's own `rate-limited` problem.

## Alternatives

- **Keep the hand-written counter and dismiss the alert** — the limit works, but every new route that checks a
  secret would need its own dismissal, and a scanner that cannot see the limit cannot catch a route that lacks one.
- **`rate-limiter-flexible`** — CodeQL recognises it only when called with a property of the request, in code the
  hub would write itself around every route; it brings more than the hub needs, such as stores for Redis and others.
- **A limit at the reverse proxy** — the hub ships without one in Compose trials and on Kubernetes ingresses that
  differ, so the limit would depend on how the operator deploys it.

## Consequences

- A route that checks a secret gets its limit by a line of route configuration, and code scanning checks it is there.
- `@fastify/rate-limit` and its four small dependencies become runtime dependencies of `@micafox/hub-core`.
- Each route has its own counter: the plugin gives each route configuration a store of its own, so the setup no
  longer shares the login's budget. The setup token is 256 random bits and works once, so this costs nothing.
- The plugin counts every request to a limited route, a malformed one too, and an IPv6 address with its /64.
- The counters stay in each replica's memory; with several replicas a shared store, such as its Redis one, replaces
  it without changing the routes.
