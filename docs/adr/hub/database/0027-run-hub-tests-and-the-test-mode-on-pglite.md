# 0027. Run hub tests and the test mode on PGlite

## Status

Proposed · 2026-11-20

## Context

Production runs on Postgres only, but `pnpm verify` must pass on a fresh clone without Docker. The hub's test mode,
which the example apps' tests start in place of the fake hub, must be ready within 2 s, leave nothing behind, and
work in the Docker image too. Tests must run the same SQL, policies and migrations as production.

## Decision

We run the hub's tests in `pnpm verify` and its test mode on PGlite, Postgres compiled to WebAssembly and run inside
the hub's process, selected by `MICAFOX_DATABASE_URL=pglite:memory` or `pglite:<folder>`, while CI also runs the
database tests on Postgres 15 and 18.

## Alternatives

- **embedded-postgres** — real Postgres binaries per platform, tens of megabytes; `initdb` and start take 2 to 5 s,
  which breaks the 2 s budget, and the image grows.
- **Testcontainers** — needs Docker for `pnpm verify`.
- **SQLite for tests** — another SQL dialect, no row-level security.

## Consequences

- PGlite has one connection and starts as a superuser: the hub creates its app role and runs as it with `SET ROLE`,
  and lock and concurrency tests run only on real Postgres in CI.
- The image carries a database migrated at build time, so `pglite:memory` starts within 2 s however many
  migrations exist.
- Proposed until a spike shows that `CREATE ROLE` and `SET ROLE` enforce row-level security in PGlite.
