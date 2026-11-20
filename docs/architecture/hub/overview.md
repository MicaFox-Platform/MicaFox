# Hub overview

## Components

```text
┌─────────┐  web app, /api/v1 (HTTPS)   ┌──────────────────── @micafox/hub ─────────────────────┐
│ Browser │────────────────────────────▶│ ┌──────────────────── hub-core ────────────────────┐  │
│         │◀────────────────────────────│ │ Server        /api/v1 · sessions · SSE · web app │  │
└─────────┘  JSON, SSE events           │ │ Access        orgs · users · keys · entitlements │  │
┌─────────┐  hello, batch (wss /sdk)    │ │ SDK endpoint  /sdk · handshake · module routing  │  │
│ App     │────────────────────────────▶│ │ Database      Kysely · RLS · migrations · writer │  │
│ + SDK   │◀────────────────────────────│ │ Events · jobs · config                           │  │
└─────────┘  welcome, breakpoints       │ └──────────────▲─────────────────────────┬─────────┘  │
                                        │  defineFeature │                         │            │
                                        │ ┌──────────────┴───────────┐             │            │
                                        │ │ Features: hub-debugger   │             │            │
                                        │ │ Extension: #ee (ee/hub)  │             │            │
                                        │ └──────────────────────────┘             │            │
                                        └──────────────────────────────────────────┼────────────┘
                                                                         SQL, pool │
                                                                                   ▼
                                                                            ┌──────────────┐
                                                                            │ Postgres 15+ │
                                                                            └──────────────┘
```

The hub receives what the SDK modules send, controls them, and is where engineers, and later the CLI and MCP tools,
work with the results. One process serves the web app, the HTTP API and the SDK endpoint, and keeps all state in
Postgres except the SDK sockets it holds.

- [App](app.md) — `@micafox/hub`: composes the features and the `#ee` extension into the basic hub and the hub
  builds, and ships them as an image, a Compose setup and a Helm chart.
- [Features](features.md) — the contract every feature and the extension implement: server routes, screens,
  migrations, jobs, retention and SDK messages.
- [Server](server.md) — Fastify, the HTTP API conventions, errors, logs, metrics, events, jobs, configuration,
  health and shutdown.
- [SDK endpoint](sdk-endpoint.md) — the WebSocket the SDK connects to: the project key, the handshake, limits and
  routing of module messages to features.
- [Database](database.md) — Kysely over Postgres, migrations, tenant isolation by row-level security, batched
  writes and PGlite for tests.
- [Access](access.md) — organizations, users, the first run, sessions, project keys, roles, entitlements and the
  threat model.
- [Debugger](debugger.md) — `@micafox/hub-debugger`: breakpoints, their statuses per instance, snapshots, their
  screens and API, within limits that keep a hub and its database bounded.
- [Web](web.md) — the single-page app: shell, routes and navigation that features extend, live updates and the
  shell's screens.
- [UI](ui.md) — `@micafox/ui`: the retro design tokens and components every screen is built from.

What a team running a hub can rely on:

- One official image for self-hosted and Cloud. Self-hosted, it sends nothing anywhere: no telemetry, and a
  licence is checked offline.
- The minimum, 1 vCPU and 1 GB next to Postgres, serves 200 connected SDK instances and 50 snapshots a second. A
  larger machine serves more without code changes: limits and pool sizes are settings.
- Any released version upgrades to the latest by starting the new image; migrations only go forward.
- Organizations are isolated by Postgres itself, so one shared Cloud deployment can hold many of them.

## Packages

| Package                 | Folder                  | Holds                                                  | Licence     | Depends on                       |
| ----------------------- | ----------------------- | ------------------------------------------------------ | ----------- | -------------------------------- |
| `@micafox/ui`           | `packages/ui`           | design tokens, fonts, icons, React components          | MIT         | -                                |
| `@micafox/hub-core`     | `packages/hub-core`     | the feature contract, server, web shell, DB, access    | AGPL-3.0    | protocol, ui                     |
| `@micafox/hub-debugger` | `packages/hub-debugger` | the debugger feature                                   | AGPL-3.0    | protocol, hub-core, ui           |
| `@micafox/hub-ee`       | `ee/hub`                | the extension with paid features; empty in S2          | `ee/` terms | protocol, hub-core, features, ui |
| `@micafox/hub`          | `packages/hub`          | the app: both builds, image, Compose setup, Helm chart | AGPL-3.0    | all of the above, ee via `#ee`   |

Every hub package is private: none is published to npm. Dependencies point down the table only, and no package
imports `ee/` except `packages/hub` through `#ee`, which ESLint enforces. Each package carries its own `LICENSE`;
`ee/LICENSE` is a proprietary, source-available licence: why, and what contributors sign:
[ADR 0022](../../adr/packages/0022-split-the-hub-into-packages-by-role.md).

The hub packages are ES modules only; the dual build of
[ADR 0013](../../adr/packages/0013-publish-the-packages-as-es-modules-and-commonjs.md) is for published packages.
Each package with server and browser code has separate entries, `.` for the server and `./web` for the browser,
plus `./schema` for the TypeBox schemas both share, so the web bundle never pulls in server code.

Two builds come from the one app:

- **hub** — the default build, with `ee/`: the official image, run self-hosted and in Cloud.
- **basic hub** — `EE=false`, AGPL code only: built in CI to prove the open core works without `ee/`, never
  published.

## Key flows

- [Starting the hub](server.md#starting) and [stopping it](server.md#stopping)
- [Building both builds](app.md#building)
- [Creating the first owner](access.md#creating-the-first-owner) and [logging in](access.md#logging-in)
- [Connecting an SDK](sdk-endpoint.md#connecting-an-sdk), [keeping its instance](sdk-endpoint.md#keeping-instances)
  and [resending the state to an environment](sdk-endpoint.md#resending-the-state)
- [Setting a breakpoint](debugger.md#setting-a-breakpoint), [taking in a snapshot](debugger.md#taking-in-a-snapshot)
  and [from a fresh hub to the first snapshot](debugger.md#from-a-fresh-hub-to-the-first-snapshot)
- [Running in test mode](server.md#running-in-test-mode) for automated tests
- [Serving a request](server.md#serving-a-request) inside its organization:
  [scoped queries](database.md#scoping-a-query)
- [Writing snapshots in batches](database.md#writing-in-batches)
- [Pushing a live update](web.md#pushing-a-live-update)
- [Migrating on start](database.md#migrating) and [upgrading a hub](app.md#upgrading)
- [Releasing the hub](app.md#releasing)

## Deferred

Not in S2; each has the socket that adds it without a redesign.

| What                                                 | Stage | Socket                                                                                   |
| ---------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| Several hub replicas behind a load balancer          | S4    | events through one bus; jobs and migrations under advisory locks; state only in Postgres |
| Personal API tokens, the CLI and MCP tools           | S3    | the `mfx_pat_` token kind and actor model; an `mcpTools` part of the feature contract    |
| `Idempotency-Key` on creating requests               | S3    | an optional header, added without breaking `/api/v1`                                     |
| The events stream in the public API                  | S3    | `/api/internal/events` moves to `/api/v1/events`                                         |
| Cloud: sign-up, many organizations, subscriptions    | S5    | `org_id` and RLS on every table; `MICAFOX_DEPLOYMENT`; a subscription entitlement source |
| Self-hosted licence keys                             | S7    | a licence entitlement source, `MICAFOX_LICENSE`                                          |
| SSO and SCIM                                         | S7    | an `authProviders` part of the extension contract that creates a normal session          |
| Fine-grained roles                                   | S7    | roles stored per membership; every check goes through one `can()`                        |
| Audit log                                            | S7    | every change already publishes an event with its actor                                   |
| Email (invites, password reset)                      | later | invite and reset links already exist; a mailer only sends them                           |
| A path prefix behind a reverse proxy                 | later | `MICAFOX_PUBLIC_URL` accepts a path                                                      |
| An encryption keyring for secrets the hub reads back | later | a keyring with `kid`, added with the first encrypted field                               |
| Logo and fox mascot                                  | S4    | assets and tokens in `@micafox/ui`                                                       |
| Mobile layouts and languages other than English      | later | layout primitives in `@micafox/ui`; UI strings in one `strings.ts` per package           |
| Breakpoint conditions                                | S6    | a compatible optional field of `Breakpoint` in protocol version 1; the create dialog     |
| Logpoints                                            | S6    | a new SDK module and feature package over the same session and contract                  |
| Source view through git connectors                   | later | `file` and `line` are repository paths, and `commit` comes with every instance           |
| SDK settings from the hub, such as capture limits    | later | a compatible module message sent with `state(session)`, as breakpoints are               |
| Central redaction policies                           | S7    | an `ee/` extension part of the debugger; the SDK's redaction stays on                    |
| Hit limits counted in the SDK                        | later | an optional `maxHits` in `Breakpoint`; the hub's own count stays the guard               |
| Instances' online state across replicas              | S4    | online asked of the replica that holds the socket, through the event bus                 |

## Decisions

- [0022. Split the hub into packages by role](../../adr/packages/0022-split-the-hub-into-packages-by-role.md)
- [0023. Build the open core and ee/ from one app with #ee](../../adr/hub/app/0023-build-the-open-core-and-ee-from-one-app-with-ee.md)
- [0035. Release the hub as an image and a chart](../../adr/packages/0035-release-the-hub-as-an-image-and-a-chart.md)
- [0008. Use WebSocket for the hub connection](../../adr/protocol/0008-use-websocket-for-the-hub-connection.md)
- [0017. Tag messages with their module and agree on modules](../../adr/protocol/0017-tag-messages-with-their-module-and-agree-on-modules.md)

Decisions of one component: [app](app.md#decisions), [server](server.md#decisions),
[SDK endpoint](sdk-endpoint.md#decisions), [database](database.md#decisions), [access](access.md#decisions),
[debugger](debugger.md#decisions), [web](web.md#decisions), [UI](ui.md#decisions).
