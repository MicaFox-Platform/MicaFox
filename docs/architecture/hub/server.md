# Hub server

## Purpose

The hub's HTTP server in `@micafox/hub-core`: one Fastify process that serves the web app and the HTTP API, carries
events between parts, runs background jobs, and starts and stops the whole hub safely.

## Boundaries

- Owns:
  - the Fastify app, its plugin order and the request context: actor, organization, scoped database;
  - the HTTP API conventions, the error format, validation of requests and responses;
  - security headers, logs, metrics, the event bus and the events stream for the web app;
  - the job scheduler, configuration, health endpoints, starting and stopping.
- Does not own: the WebSocket for the SDK: [SDK endpoint](sdk-endpoint.md); queries and migrations:
  [database](database.md); who the actor is and what they may do: [access](access.md); feature routes:
  [features](features.md).
- Constraints:
  - In memory only what a replica may lose: SDK sockets, events streams, caches that expire within 60 s, login rate
    counters and the write queue. Everything else is in Postgres, so several replicas stay possible
    ([Deferred](overview.md#deferred)).
  - Every setting comes from the environment and is checked before the hub listens.

## Interactions

```text
┌────────┐  HTTP request   ┌─────────────────────────────── Fastify ────────────────────────────────┐
│ Client │────────────────▶│ request id → headers → actor → origin check → validation → org, db     │
│        │◀────────────────│ → route (core, feature, extension) → response schema → problem+json    │
└────────┘  JSON, problem  └───────────────────────┬────────────────────────────────▲───────────────┘
                                                   │ publish after commit           │ events for its org
                                                   ▼                                │
                                     ┌──────────── event bus ──────────┐   ┌────────┴───────────┐
                                     │ in-process in S2                │──▶│ events stream: SSE │
                                     └───────────────┬─────────────────┘   └────────────────────┘
                                                     │ resend state to an environment
                                                     ▼
                                     ┌─────────────────────────────────┐
                                     │ SDK endpoint                    │
                                     └─────────────────────────────────┘
```

## Layout

```text
packages/hub-core/src/server/
├── index.ts          createHub() and the server entry's exports
├── app/              the Fastify app, plugin order, request context, error handler, the web app's files
├── config/           the settings' schema, *_FILE values, the start-up report of problems
├── observability/    the pino logger with redaction, Prometheus metrics
├── events/           the event bus and the SSE events stream
├── jobs/             the scheduler, advisory locks, the retention runner
├── lifecycle/        start, readiness, /healthz and /readyz, shutdown
├── feature/          the feature contract: features.md
├── sdk-endpoint/     the SDK's WebSocket: sdk-endpoint.md
├── db/               Kysely, access modes, migrator, writer: database.md
└── access/           organizations, users, sessions, keys, entitlements: access.md
```

## Key flows

### Starting

1. The settings are read from the environment and `*_FILE` files and checked against their schema; on any problem
   the hub prints all of them and exits with code 1. [Settings](../../api/hub/config.md).
2. The app registers every plugin and listens on `MICAFOX_PORT`, and on `MICAFOX_METRICS_PORT` when set.
   `/healthz` answers 200 from now on; `/readyz`, every other route and SDK upgrades answer 503 until step 5.
3. It connects to Postgres, retrying with backoff while it is unreachable. It exits with code 1 when the app role is
   a superuser or has `BYPASSRLS`, or when the database holds a migration this image does not know; otherwise it
   [migrates](database.md#migrating).
4. Without an owner, it prints the one-time [setup token](access.md#creating-the-first-owner).
5. It starts the jobs, turns ready and logs `hub.started` with the version, the build (hub or basic hub), the
   features and the settings without secrets.

### Running in test mode

1. `MICAFOX_TEST_MODE=true` starts the hub for automated tests and the Docker test stacks, from the same image and
   build. It refuses to start unless `MICAFOX_DATABASE_URL` is `pglite:memory` or `pglite:<folder>`, and logs a
   warning that it accepts SDK connections without a key.
2. On an empty database it seeds the organization `Test`, the owner `owner@micafox.test` with
   `MICAFOX_TEST_PASSWORD`, the project `test` with its `production` environment, and that environment's project
   key from `MICAFOX_TEST_PROJECT_KEY`. A password or key not given is generated. A folder that already holds the
   seed is used as it is, so a test can restart the hub on it and find its breakpoints.
3. `MICAFOX_PORT=0` takes a free port. Without `MICAFOX_PUBLIC_URL`, the public URL is `http://localhost:<port>`
   once bound, so the origin check and cookies work on it.
4. Turning ready logs `hub.started` with `url`, the SDK URL, the seeded ids, and the password and key when they were
   generated. `tools/testkit` reads that line, logs in with `POST /api/v1/session` and drives the tests through the
   public API, polling it until a status or snapshot appears.
5. The [SDK endpoint](sdk-endpoint.md#connecting-an-sdk) lets a connection without a key into the seeded
   environment, so apps in Docker reach the hub over plain `ws://` by its host name. Everything else, limits and
   checks included, is the same as in production.
6. It is ready within 2 s and stays under 256 MB of memory with the example apps' load. Why:
   [ADR 0037](../../adr/hub/server/0037-start-a-seeded-test-mode-on-pglite.md).

### Serving a request

1. Fastify gives the request an id, echoed in `x-request-id`, and sets the security headers: a CSP of
   `default-src 'self'` with no inline scripts, `frame-ancestors 'none'`, `nosniff`,
   `Referrer-Policy: same-origin`, and HSTS when `MICAFOX_PUBLIC_URL` is HTTPS. `MICAFOX_TRUST_PROXY` decides
   which proxies' forwarded headers it believes.
2. [Access](access.md#logging-in) finds the actor from the session cookie, and rejects a changing request whose
   `Origin` is not the hub's.
3. TypeBox schemas check the path, query and body, at most 1 MiB; a failure is a 400 problem of type `validation`.
4. A route under an organization checks the actor's membership, answering 404 to a non-member so nothing leaks
   that it exists, and gets [`db.forOrg(orgId)`](database.md#scoping-a-query).
5. The response goes through its schema, which drops any field it does not list. Errors become
   `application/problem+json`; an unexpected one is a 500 of type `internal` with the request id, logged with its
   stack, never with its message in the response.
6. One log line per request at `info`: method, route, status, duration, request id, organization and user.

Paths, errors and pagination: [HTTP API](../../api/hub/http.md). Why:
[ADR 0025](../../adr/hub/server/0025-build-the-hub-server-on-fastify-with-typebox-schemas.md),
[ADR 0031](../../adr/hub/server/0031-version-the-http-api-in-the-path-errors-as-rfc-9457.md).

### Serving the web app

1. `dist/web/assets/*` have hashed names and are cached for a year.
2. Any other `GET` outside `/api`, `/sdk`, `/healthz` and `/readyz` gets `index.html`, not cached, and the
   [web app](web.md) routes in the browser.

### Events

1. A part publishes `{ type, orgId, environmentId?, actor, data }` once its transaction commits. Types are
   `<feature>.<noun>.<verb>`, such as `debugger.snapshot.created`; core ones are `project.*`, `environment.*`,
   `key.*`, `member.*` and `invite.*`.
2. In S2 the bus is in-process. Subscribers are the events streams, which pass on what belongs to their session's
   organizations, and the [SDK endpoint](sdk-endpoint.md#resending-the-state). With several replicas the same
   interface carries events through Postgres.
3. Each stream keeps at most 100 undelivered events; a slower one gets `reset` and its queue is dropped.

### Jobs

1. Each job of hub-core or a feature runs every `everyMs`. At each tick the scheduler takes
   `pg_try_advisory_lock` for the job on a connection of its own and skips the run when another holds it.
2. A run is limited to its interval, 10 minutes at most; the next one starts after it ends. Failures are logged and
   counted.
3. Core jobs: delete expired sessions, invites and reset links every hour; write the last use of project keys and
   the last seen time of online [instances](sdk-endpoint.md#keeping-instances) every minute; delete instances
   offline for 7 days every hour; run each feature's retention policy every hour, per organization, in batches.

### Logging

1. pino writes JSON to stdout; `MICAFOX_LOG_FORMAT=pretty` is for development. `MICAFOX_LOG_LEVEL` is `info` by
   default. The hub keeps no logs of its own: the operator collects stdout.
2. Fields: `time`, `level`, `msg`, `reqId`, `orgId`, `userId`, `route`, `statusCode`, `durationMs`; for the SDK
   `instanceId`, `environmentId` and `keyPrefix`, never the key.
3. `error` is for bugs and the unexpected; `warn` for rejected keys, protocol errors and dropped data, each repeat
   collapsed into one line a minute with a count; `info` for start, stop, migrations, SDK connects and requests,
   except `/healthz`, `/readyz` and metrics.
4. Security events, such as a login, a failed login, a key created or revoked, an invite or a role change, are
   `info` lines with an `event` field.
5. Never logged: `Authorization`, `Cookie`, `Set-Cookie`, passwords, tokens and snapshot contents. The only secrets
   the log ever holds are the setup token, printed while no owner exists, and the password and key that
   [test mode](#running-in-test-mode) generates when none is given.

### Metrics

1. With `MICAFOX_METRICS_PORT` set, a second listener serves Prometheus metrics on that port, not through the
   proxy.
2. Process: CPU, memory, event loop delay and GC. HTTP: requests and their duration by route and status. SDK: open
   sockets, connects by result, messages by module and type, dropped data by reason. Database: rows written, the
   write queue, the pool, query duration. Jobs: runs by job and result.
3. No label holds an organization or a user.

### Stopping

1. On `SIGTERM` or `SIGINT` the hub turns `/readyz` to 503 and ends the events streams.
2. It closes SDK sockets with code 1001; the SDK reconnects with backoff.
3. It stops accepting connections and lets running requests finish for up to 10 s, then waits up to 10 s for
   running jobs, writes the [write queue](database.md#writing-in-batches) for up to 5 s, closes its pools and exits
   with code 0, within Kubernetes' 30 s. A second signal exits at once with code 1.

## Decisions

- [0025. Build the hub server on Fastify with TypeBox schemas](../../adr/hub/server/0025-build-the-hub-server-on-fastify-with-typebox-schemas.md)
- [0031. Version the HTTP API in the path, errors as RFC 9457](../../adr/hub/server/0031-version-the-http-api-in-the-path-errors-as-rfc-9457.md)
- [0037. Start a seeded test mode on PGlite](../../adr/hub/server/0037-start-a-seeded-test-mode-on-pglite.md)
