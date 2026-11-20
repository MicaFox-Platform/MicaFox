# 0028. Isolate organizations with row-level security

## Status

Proposed · 2026-11-20

## Context

Snapshots hold the data of the apps they were taken in. Cloud will run one shared hub and one database for every
customer, so a single forgotten filter must not show one organization's data to another. Some lookups happen before
the organization is known: a project key on the SDK upgrade, a session cookie, an invite link. Snapshots are written
in batches that mix organizations, through a connection pool.

## Decision

We isolate organizations in Postgres with row-level security: every organization's table has `org_id` and a forced
policy on the transaction setting `micafox.org_id`, which `db.forOrg(orgId)` sets with `set_config` at the start of
each transaction; a short list of global tables without row-level security serves lookups by hash, and jobs that
work across organizations use an explicit system access.

## Alternatives

- **Filters in code only** — `db.forOrg()` and a lint rule, but one raw query without the filter leaks data.
- **A schema per organization** — strong isolation, but every migration runs once per organization, which does not
  scale to many Cloud customers.
- **A database per organization** — the strongest, at the cost of one database to run per customer.

## Consequences

- The hub refuses to start when its role is a superuser or has `BYPASSRLS`; Compose and the chart create an owner
  role for migrations and an app role for the hub, and `MICAFOX_MIGRATION_DATABASE_URL` is optional elsewhere.
- The policy reads the setting with `nullif(…, '')`, so a pooled connection that ran an earlier transaction matches
  no row rather than failing.
- The batch writer sets the organization before each organization's group of rows in one transaction.
- Every start checks that each table outside the global list has row-level security forced; an isolation test calls
  every endpoint and the events stream with another organization's ids.
- Proposed until the PGlite spike of [ADR 0027](0027-run-hub-tests-and-the-test-mode-on-pglite.md) passes, since
  `pnpm verify` relies on it.
