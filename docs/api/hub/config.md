# Hub configuration

## Installation

The hub reads its settings from the environment when it starts. It checks all of them first; on any problem it
prints every one and exits with code 1. Settings marked `_FILE` can instead be read from a file, such as a Docker or
Kubernetes secret: `MICAFOX_DATABASE_URL_FILE=/run/secrets/db`. A file is read as text up to 64 KiB, without its
final newline. A setting given both directly and as `_FILE` is a problem, and an empty variable counts as not set.

## Exports

### Settings

| Setting                                    | Default               | Meaning                                                                                       |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------- |
| `MICAFOX_PUBLIC_URL`                       | required              | the URL users open: `https://…`, or `http://` on `localhost`, `127.0.0.1` or `[::1]`; no path |
| `MICAFOX_DATABASE_URL` (`_FILE`)           | required              | `postgres://…` for the app role, or `pglite:memory` / `pglite:<folder>` for tests and trials  |
| `MICAFOX_MIGRATION_DATABASE_URL` (`_FILE`) | the database URL      | the owner role that runs migrations; unset or the same URL for a `pglite:` database           |
| `MICAFOX_DATABASE_POOL_SIZE`               | `10`                  | connections in the pool                                                                       |
| `MICAFOX_HOST`, `MICAFOX_PORT`             | `0.0.0.0`, `8080`     | where the hub listens; port `0` takes a free one                                              |
| `MICAFOX_TRUST_PROXY`                      | `false`               | which proxies' `X-Forwarded-*` to believe: `true`, a hop count, or IPs and CIDRs              |
| `MICAFOX_LOG_LEVEL`                        | `info`                | `debug`, `info`, `warn` or `error`                                                            |
| `MICAFOX_LOG_FORMAT`                       | `json`                | `json`, or `pretty` for development                                                           |
| `MICAFOX_METRICS_PORT`                     | off                   | a port for Prometheus metrics, apart from the API                                             |
| `MICAFOX_SETUP_TOKEN` (`_FILE`)            | a random one, logged  | the setup token for the first owner, for automation                                           |
| `MICAFOX_SOURCE_URL`                       | this version's source | where the UI's Source link points; set it when you run a modified hub                         |
| `MICAFOX_SDK_MAX_FRAME_BYTES`              | `1048576`             | largest frame from the SDK; raise it with the SDK's `buffer.maxBytes`                         |
| `MICAFOX_SDK_MAX_CONNECTIONS`              | `1000`                | SDK connections per hub                                                                       |
| `MICAFOX_SDK_MAX_CONNECTIONS_PER_KEY`      | `500`                 | SDK connections per project key                                                               |
| `MICAFOX_SDK_MAX_MESSAGES_PER_SECOND`      | `1000`                | messages a second per SDK connection, over 10 s                                               |
| `MICAFOX_WRITE_QUEUE_MAX_BYTES`            | `10485760`            | rows waiting to be written; more are dropped and counted                                      |
| `MICAFOX_RETENTION_<NAME>_DAYS`            | set by each feature   | how long a feature keeps its data, such as `MICAFOX_RETENTION_SNAPSHOTS_DAYS` (30)            |
| `MICAFOX_DEBUGGER_SNAPSHOTS_PER_SECOND`    | `100`                 | snapshots the hub takes in per environment a second, over 10 s; more are dropped and counted  |
| `MICAFOX_DEBUGGER_MAX_SNAPSHOTS`           | `100000`              | snapshots kept per environment; the oldest are deleted every minute                           |
| `MICAFOX_TEST_MODE`                        | `false`               | `true` starts [test mode](#test-mode); only with a `pglite:` database                         |
| `MICAFOX_TEST_PROJECT_KEY` (`_FILE`)       | generated, logged     | the seeded environment's project key in test mode, `mfx_pk_` and 43 characters                |
| `MICAFOX_TEST_PASSWORD` (`_FILE`)          | generated, logged     | the seeded owner's password in test mode, 12 to 256 characters                                |

The hub refuses to start when `MICAFOX_PUBLIC_URL` is HTTP on another host, when its database role is a superuser or has
`BYPASSRLS`, when the database refuses it (such as for a wrong password), when the database was migrated by a newer hub,
when the migration role cannot connect, or when a table other than the global ones lacks `org_id` under forced row-level
security. While the database is unreachable it waits and retries, with `/readyz` at 503. On a `pglite:` database it logs
that PGlite is not for production.

### Test mode

For automated tests and test stacks, never for real data. With `MICAFOX_TEST_MODE=true` and a `pglite:` database the
hub seeds, on an empty database, the organization `Test`, the owner `owner@micafox.test`, the project `test` with
its `production` environment, and a project key for it. SDK connections without a key join that environment too,
so apps in Docker can use plain `ws://`. Without `MICAFOX_PUBLIC_URL` the public URL is `http://localhost:<port>`.
When ready, the hub logs one `hub.started` line with `url`, `sdkUrl`, `orgId`, `projectId`, `environmentId`, and the
password and key when it generated them. It starts within 2 s.

```sh
MICAFOX_TEST_MODE=true MICAFOX_DATABASE_URL=pglite:memory MICAFOX_PORT=0 \
  MICAFOX_TEST_PROJECT_KEY=mfx_pk_0000000000000000000000000000000000000000000 micafox-hub start
```

### Commands

Run them inside the hub's container: `docker compose exec hub micafox-hub <command>` or
`kubectl exec deploy/hub -- micafox-hub <command>`.

- `micafox-hub start` — the image's default: migrate, then serve.
- `micafox-hub migrate` — run the missing migrations and exit.
- `micafox-hub reset-password <email>` — print a one-time link, valid for an hour, to set a new password.
- `micafox-hub version` — print the version and the build.

### Health and metrics

- `GET /healthz` — 200 while the process runs, also during migrations.
- `GET /readyz` — 200 when the database answers, migrations are done and the hub is not stopping; 503 otherwise,
  also while the hub waits for an unreachable database.
- `GET /metrics` on `MICAFOX_METRICS_PORT` — Prometheus metrics of the process, HTTP, SDK connections, the database
  and jobs, without organization or user labels.

Logs are JSON lines on stdout; collect them with your platform. `SIGTERM` stops the hub within 30 s.

## Usage

```sh
MICAFOX_PUBLIC_URL=https://hub.example.com
MICAFOX_DATABASE_URL_FILE=/run/secrets/db_app_url
MICAFOX_MIGRATION_DATABASE_URL_FILE=/run/secrets/db_owner_url
MICAFOX_TRUST_PROXY=1
MICAFOX_METRICS_PORT=9464
```
