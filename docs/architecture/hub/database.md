# Hub database

## Purpose

How the hub stores everything in Postgres: typed queries with Kysely, migrations of hub-core, the features and the
extension, isolation of organizations by row-level security, batched writes for the SDK's data, and PGlite for
tests and the test mode.

## Boundaries

- Owns:
  - the pool, the three ways code gets a database handle, and the RLS policies they rely on;
  - the migrator, its order, its lock and its checks;
  - the write queue for high-rate inserts;
  - the PGlite adapter and its seed.
- Does not own: the tables of a feature, which the feature defines in its migrations; backups, which are the
  operator's job with `pg_dump`.
- Constraints:
  - Postgres 15 or later in production; CI tests 15 and 18, and PGlite runs 17.
  - Every table holds rows of one organization, with `org_id` and a policy, unless it is one of the global tables
    below. The start fails on any other table without row-level security.
  - The app role is neither a superuser nor `BYPASSRLS`, or the hub does not start.

## Interactions

```text
┌──────────────────┐ request db   ┌─────────────────────── db ────────────────────────┐   SQL   ┌──────────┐
│ route, feature   │─────────────▶│ db.forOrg(orgId): a transaction with the org set  │────────▶│ Postgres │
├──────────────────┤ lookups      │ db.global: global tables, auth only               │────────▶│ RLS on   │
│ access (auth)    │─────────────▶│ db.system(reason): jobs across organizations      │────────▶│ org rows │
├──────────────────┤ rows         │ writer: batches per org, one transaction a flush  │────────▶│          │
│ SDK messages     │─────────────▶│ migrator: owner role, advisory lock, in order     │────────▶│          │
└──────────────────┘              └───────────────────────────────────────────────────┘         └──────────┘
```

## Layout

```text
hub/core/src/server/db/
├── index.ts          the pool and the three handles
├── scope.ts          forOrg, global and system: transactions and session settings
├── policies.ts       the RLS policy helpers migrations use
├── migrator/         the ordered migrator, its lock, the unknown-migration and RLS checks
├── writer/           the write queue: batching, upserts, per-organization groups, limits, rejected rows
├── pglite/           the PGlite dialect, the app role inside it, the seed
└── migrations/       hub-core's own migrations: 0001-<name>.ts, ...
```

## Key flows

### Scoping a query

1. Each organization's table has `org_id` and the policy
   `org_id = nullif(current_setting('micafox.org_id', true), '')::uuid`, with `FORCE ROW LEVEL SECURITY`. A
   setting left empty by an earlier transaction on the same pooled connection matches no row instead of failing.
2. `db.forOrg(orgId)` opens a transaction and runs `set_config('micafox.org_id', $1, true)` first, so the setting
   ends with the transaction. Routes under an organization get only this handle.
3. `db.global` reads and writes the global tables, without RLS. Only `access` and `db` may import it, which ESLint
   enforces.
4. `db.system(reason)` sets `micafox.system` for one transaction, which the policies also accept, and logs the
   reason. Only jobs that work across organizations use it, such as retention.
5. The hub connects as an app role without superuser or `BYPASSRLS`; migrations run as the owner role when
   `MICAFOX_MIGRATION_DATABASE_URL` is set, and as the app role otherwise. Why RLS:
   [ADR 0028](../../adr/hub/database/0028-isolate-organizations-with-row-level-security.md).

| Global table  | Holds                                                | Read by                                                   |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `orgs`        | organizations                                        | id, and the actor's memberships                           |
| `users`       | people: email, password hash                         | id, email at login                                        |
| `memberships` | a user's role in an organization                     | user or organization                                      |
| `sessions`    | UI sessions: hash, user, expiry                      | hash of the cookie only                                   |
| `credentials` | keys and links: project keys, invites, resets, setup | SHA-256 hash at lookup; by organization in key management |
| `settings`    | hub-wide values, such as whether an owner exists     | key                                                       |
| migrations    | one table per package: what ran                      | the migrator                                              |

### Migrating

1. On every start, and with `micafox-hub migrate`, the migrator takes a session advisory lock on a client of its
   own, so two starting replicas never migrate at once and the lock never stays on a pooled connection.
2. It reads the migrations of hub-core, then of each feature in the app's order, then of the extension. Each
   package has its own table of migrations run, so a new core migration never conflicts with a feature's.
3. A migration this image does not know stops the start: the database belongs to a newer hub
   ([upgrading](app.md#upgrading)). Otherwise it runs the missing ones in order, each in a transaction unless it
   exports `transaction = false`, as `CREATE INDEX CONCURRENTLY` needs. Migrations have no `down`: released ones
   never change, and any released version migrates to the latest.
4. Afterwards it checks that every table outside the global list has `org_id`, RLS enabled and forced; otherwise
   the start fails, naming the table.

Why Kysely and per-package migrations:
[ADR 0026](../../adr/hub/database/0026-query-postgres-with-kysely-and-migrate-per-package.md).

### Writing in batches

1. Features write high-rate rows, such as snapshots, through `writer.insert(table, orgId, row)`, never one
   `INSERT` each. Rows that only hold the latest value, such as a breakpoint's status on an instance, go through
   `writer.upsert(table, orgId, row, key)`: a newer row with the same key replaces the queued one.
2. The writer flushes every 50 ms or at 500 rows: one transaction that, for each organization's group, runs
   `set_config('micafox.org_id', …, true)` and one multi-row `INSERT`, or `INSERT … ON CONFLICT … DO UPDATE`.
3. The queue holds at most `MICAFOX_WRITE_QUEUE_MAX_BYTES` (10 MiB). While Postgres is down it retries with backoff,
   and rows that do not fit are dropped and counted.
4. A flush that fails on its data, SQLSTATE class 22 or 23, is never retried whole: the writer splits it, writes
   the good rows, and drops and counts the rows Postgres rejects, with a collapsed warning naming the table.
5. The pool has `MICAFOX_DATABASE_POOL_SIZE` connections (10); a larger machine raises it together with the limits.

### Running on PGlite

1. `MICAFOX_DATABASE_URL=pglite:memory` or `pglite:<folder>` runs the hub on PGlite inside its own process, for tests,
   the [test mode](server.md#running-in-test-mode) and trials; the hub logs that it is not for production. A new
   folder starts from the same seed as `pglite:memory`.
2. PGlite connects as a superuser, so the adapter creates the app role and runs as it with `SET ROLE`; the
   superuser check applies to that role.
3. `pglite:memory` loads `pglite-seed.tar.gz`, a database already migrated at build time, then runs only what is
   missing, so start-up stays within 2 s however many migrations exist.
4. PGlite has one connection, so `pnpm verify` cannot prove locks or concurrency; those tests run only in CI on
   Postgres 15 and 18, with the rest of the database tests. Why PGlite:
   [ADR 0027](../../adr/hub/database/0027-run-hub-tests-and-the-test-mode-on-pglite.md).

### Keeping data within bounds

Every feature declares its [retention](features.md#server-part); hub-core runs each policy every hour, per
organization, and operators change the defaults with `MICAFOX_RETENTION_<NAME>_DAYS`. Expired sessions, invites
and links are deleted by a core job.

## Decisions

- [0026. Query Postgres with Kysely and migrate per package](../../adr/hub/database/0026-query-postgres-with-kysely-and-migrate-per-package.md)
- [0027. Run hub tests and the test mode on PGlite](../../adr/hub/database/0027-run-hub-tests-and-the-test-mode-on-pglite.md)
- [0028. Isolate organizations with row-level security](../../adr/hub/database/0028-isolate-organizations-with-row-level-security.md)
