# 0026. Query Postgres with Kysely and migrate per package

## Status

Accepted · 2026-11-20

## Context

Postgres is the hub's only store. The core, every feature and the extension own tables, so migrations come from
several packages and must run in a fixed order; any released version must migrate to the latest, forward only.
Queries must be typed, must run inside a transaction that sets the organization for row-level security, and must
also run on PGlite in tests. The hub should stay light.

## Decision

We query Postgres with Kysely over `pg`, and each package keeps its migrations as TypeScript modules with only an
`up`, which one migrator runs in order (core, the features, the extension) under an advisory lock, with a table of
migrations run per package.

## Alternatives

- **Drizzle** — schema in TypeScript and an official PGlite driver, but its migrations are generated from one
  schema's diff, which fits poorly with separate migrations in the core, the features and `ee/` in one order.
- **Plain SQL over `pg` with an own migrator** — full control, but every result type is written by hand.
- **Prisma** — a heavy engine and one schema for the whole app, against packages that each own their tables.

## Consequences

- Queries are typed without code generation; table types are written next to the migrations.
- Kysely's dialects run the same queries on Postgres and PGlite.
- A new core migration never conflicts with a feature's, because each package tracks its own.
- Released migrations never change; a migration that cannot run in a transaction says so.
