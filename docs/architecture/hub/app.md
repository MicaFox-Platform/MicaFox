# Hub app

## Purpose

`@micafox/hub` is the hub application: it composes the features and the `#ee` extension, builds the server and the
web app, and ships them as the official image, a Compose setup and a Helm chart. Operators run it; nobody imports it.

## Boundaries

- Owns:
  - the list of features in their migration order, and the `#ee` import with its empty stub;
  - the two builds: **hub** (default, with `ee/`) and **basic hub** (`EE=false`), and the check that the basic hub
    holds no file from `ee/`;
  - the `micafox-hub` command, also exported as `./cli` for `tools/testkit`
    ([ADR 0038](../../adr/packages/0038-let-the-test-kit-start-the-built-hub.md)), the Dockerfile,
    `deploy/compose.yaml` with Caddy, and the Helm chart;
  - the hub's version, changelog and release.
- Does not own: what runs inside the process, which is [hub-core](overview.md#packages) and the
  [features](features.md); the image's settings, which are [configuration](../../api/hub/config.md).
- Constraints:
  - The only package that imports `ee/`, and only through `#ee` and `#ee/web`.
  - One image for self-hosted and Cloud, ≤ 150 MB compressed, running as a non-root user on a read-only root
    filesystem.
  - One replica until several replicas are supported ([Deferred](overview.md#deferred)).

## Interactions

```text
Build time
┌───────────────────────┐ import "#ee", "#ee/web"  ┌───────────────────────────────────────────┐
│ hub/app/src           │─────────────────────────▶│ default: @micafox/hub-ee (ee/hub)         │
│ features.ts, web/     │                          │ EE=false: src/ee-stub.ts, web/ee-stub.ts  │
└───────────┬───────────┘                          └───────────────────────────────────────────┘
            │ esbuild (server), Vite (web)
            ▼
┌───────────────────────┐ metafile, module ids     ┌───────────────────────────────────────────┐
│ dist/                 │─────────────────────────▶│ check-open-core: no path from ee/         │
└───────────────────────┘                          └───────────────────────────────────────────┘

Run time (Compose)
┌──────────────┐  HTTPS, wss :443  ┌───────┐  HTTP, ws :8080  ┌─────┐  SQL :5432  ┌─────────────┐
│ Browser, SDK │──────────────────▶│ Caddy │─────────────────▶│ hub │────────────▶│ postgres:18 │
└──────────────┘                   └───────┘                  └─────┘             └─────────────┘
```

## Layout

```text
hub/app/
├── src/
│   ├── index.ts            the server entry: createHub() with the features and the extension
│   ├── features.ts         the server features in migration order, and the #ee import
│   ├── ee-stub.ts          the empty server extension of the basic hub
│   ├── cli.ts              micafox-hub: start, migrate, version; reset-password comes with its card
│   ├── bin.ts              the micafox-hub executable and the ./cli export: runs cli.ts on the process
│   ├── conditions.ts       the build conditions for esbuild, Vite, Vitest and Node, in one place
│   └── web/
│       ├── index.html      the page the server serves for every app route
│       ├── main.tsx        the browser entry: mounts the shell with the web features
│       ├── features.ts     the web features and the #ee/web import
│       └── ee-stub.ts      the empty web extension of the basic hub
├── scripts/
│   ├── build.ts            esbuild for the server, Vite for the web, the PGlite seed
│   └── check-open-core.ts  fails when a path from ee/ is in the basic hub build or image
├── deploy/
│   ├── compose.yaml        Caddy, the hub and Postgres for self-hosting
│   ├── Caddyfile           TLS and the reverse proxy to the hub
│   ├── postgres-init.sql   the owner role for migrations and the app role for the hub
│   └── chart/              the Helm chart
├── Dockerfile              one image; the EE build argument picks the build
└── LICENSE                 AGPL-3.0-only
```

## Key flows

### Building

1. `pnpm build` builds the hub: esbuild bundles `src/index.ts` and `src/bin.ts` into `dist/server/` as ES modules with
   source maps, sharing one chunk of hub-core and its dependencies, and writes its metafile to `dist/metafile.json`;
   Vite builds `src/web/` into `dist/web/` with hashed assets and source maps. The built bundle then runs every
   migration into PGlite and saves the data folder as `dist/pglite-seed.tar.gz`, so the seed holds exactly that build's
   migrations. Only PGlite, which ships WebAssembly, pg's optional `pg-native` and ws's optional `bufferutil` and
   `utf-8-validate`, which are never installed and have fallbacks, stay outside the bundle. `bin.ts` is `micafox-hub`
   and the `./cli` export; tsc only checks types.
2. `EE=false` adds the condition `micafox-open-core`, so `#ee` and `#ee/web` resolve to the stubs; any `EE` other
   than unset, `true` or `false` fails the build. `conditions.ts` is the one source of the condition for esbuild `conditions`, Vite `resolve.conditions` (spread after Vite's
   defaults, which it otherwise replaces), Vitest and `node --conditions` in development. `pnpm typecheck` checks
   both variants, so the stubs keep the extension's type.
3. `check-open-core` reads the esbuild metafile and Vite's module ids of the basic hub build and fails on any path
   under `ee/` or any `@micafox/hub-ee` module, also one left external; the Docker job runs it over the basic hub
   image's filesystem too. `pnpm test:open-core` builds the basic hub and runs it, in `pnpm verify` and CI.
   Migrations and assets of `ee/` reach the app only through the imported extension, never from disk.
4. `docker build --build-arg EE=false` builds the basic hub image; without the argument it builds the hub image.

Why one app with `#ee`: [ADR 0023](../../adr/hub/app/0023-build-the-open-core-and-ee-from-one-app-with-ee.md).

### Running with Compose

1. The operator downloads `compose.yaml`, `Caddyfile` and `postgres-init.sql` from the release, sets
   `MICAFOX_DOMAIN` and the Postgres passwords in `.env`, and runs `docker compose up -d`.
2. Postgres runs `postgres-init.sql` on its first start: an owner role that runs migrations and an app role without
   superuser or `BYPASSRLS` that the hub runs as ([database](database.md#scoping-a-query)).
3. Caddy terminates TLS with a certificate for `MICAFOX_DOMAIN` from Let's Encrypt, or from its own CA on a private
   network, whose root apps then trust through `NODE_EXTRA_CA_CERTS`; it proxies HTTP and WebSocket to the hub. The
   SDK sends its key only over TLS to any host but localhost
   ([ADR 0006](../../adr/sdk/connector/0006-authenticate-to-the-hub-with-a-bearer-token.md)), and the session
   cookie needs HTTPS.
4. To try the hub on one machine, the hub's port is also bound to `127.0.0.1:8080`, with
   `MICAFOX_PUBLIC_URL=http://localhost:8080`.

### Running on Kubernetes

1. The operator installs `oci://ghcr.io/micafox-platform/charts/hub` with a Postgres they run, usually a managed
   one, given by a Secret with the app role's URL and, optionally, the owner role's URL for migrations.
2. The chart runs one replica with the `Recreate` strategy and refuses more than one. A `startupProbe` on `/readyz`
   allows 10 minutes for migrations; readiness checks `/readyz`, liveness `/healthz`; the pod gets 30 s to stop.
3. `size: small | medium | large` sets the resources (1 vCPU and 1 GB, 2 and 2, 4 and 4) and the limits and pool
   size that match them. The pod runs as non-root with a read-only root filesystem and an `emptyDir` for `/tmp`; an
   optional Ingress keeps WebSocket connections open, and an optional ServiceMonitor scrapes the metrics port.
4. CI installs the chart into a kind cluster with Postgres 18, waits for readiness, connects an SDK, and upgrades it
   from the previous chart version.

### Upgrading

1. The operator takes a `pg_dump`, then starts the new image: `docker compose up -d` with the new tag, or
   `helm upgrade`. The old process stops first ([stopping](server.md#stopping)); apps keep their breakpoints and
   reconnect with backoff.
2. The new hub answers `/healthz` at once and `/readyz` with 503 until it is ready. If the database holds a
   migration this image does not know, it exits with code 1: the database was migrated by a newer hub.
3. Otherwise it [migrates](database.md#migrating) from whatever released version the database is on, then turns
   ready. A downgrade is a restore of the dump taken before.
4. CI upgrades a database from every released hub image to the candidate before a release.

### Releasing

1. A pull request that changes what hub users see adds a changeset for `@micafox/hub`, whatever hub package it
   touches; CI requires one for changes under `hub/`, `packages/ui/` and `ee/`.
2. The version pull request bumps `@micafox/hub` and writes its `CHANGELOG.md`; the release pull request into
   `main` tags `@micafox/hub@<version>`.
3. The release workflow builds the hub image and pushes `ghcr.io/micafox-platform/hub:<version>`,
   `:<major>.<minor>` and, for the highest version, `:latest`, with provenance; it pushes the chart with the same
   version and adds a GitHub Release with the changelog and the Compose files. The basic hub image is never pushed.

Why: [ADR 0035](../../adr/packages/0035-release-the-hub-as-an-image-and-a-chart.md).

## Decisions

- [0022. Split the hub into packages by role](../../adr/packages/0022-split-the-hub-into-packages-by-role.md)
- [0023. Build the open core and ee/ from one app with #ee](../../adr/hub/app/0023-build-the-open-core-and-ee-from-one-app-with-ee.md)
- [0035. Release the hub as an image and a chart](../../adr/packages/0035-release-the-hub-as-an-image-and-a-chart.md)
