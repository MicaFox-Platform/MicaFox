# 0037. Start a seeded test mode on PGlite

## Status

Accepted · 2026-11-20

## Context

The example apps' end-to-end tests and the Docker test stacks replace the fake hub with the real one. They need a
hub that starts as one process within 2 s on a free port and says which, keeps nothing afterwards, has a project and
a key the apps are started with, and that a test drives like a user through the public API: set a breakpoint, read
its statuses and snapshots. It must run from the same image and in both builds. Personal API tokens arrive only in
S3. In Docker, apps reach the hub at a host name, and the SDK sends a key over plain `ws://` only to loopback
([ADR 0006](../../sdk/connector/0006-authenticate-to-the-hub-with-a-bearer-token.md)).

## Decision

We add a test mode, `MICAFOX_TEST_MODE=true`, allowed only on PGlite, that seeds an organization, an owner, a project,
an environment and a project key from `MICAFOX_TEST_*`, takes its public URL from the port it bound, and accepts SDK
connections without a key into the seeded environment; tests log in as the seeded owner with
`POST /api/v1/session`.

## Alternatives

- **A seeded personal API token** — builds token authentication a stage early, only for tests.
- **TLS in the Docker test stacks** — Caddy with its own CA in every stack, its root shared with every app through
  `NODE_EXTRA_CA_CERTS`: slower to start and more to keep working, for no added coverage of the hub.
- **A separate test command or binary** — a second entry to keep in step with `start`, and the image would differ
  from what operators run.

## Consequences

- The official image carries a path that accepts SDK connections without a key. It is fenced: test mode refuses to
  start on Postgres, warns at start, and its data lives in memory or a temporary folder.
- Tests exercise the same login, routes and SDK endpoint as production; only the seed and the keyless connection
  differ.
- The log may hold the generated test password and key, which is acceptable only because test mode holds no real
  data.
- Test mode rests on PGlite enforcing row-level security under `SET ROLE`, the spike that
  [ADR 0027](../database/0027-run-hub-tests-and-the-test-mode-on-pglite.md) waits for.
