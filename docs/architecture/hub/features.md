# Hub features

## Purpose

The contract that turns a package into a hub feature: its routes, screens, migrations, jobs, retention and SDK
messages. The debugger is the first feature; error tracking and logpoints follow the same contract, and `ee/` adds
paid parts through an extension of the same shape.

## Boundaries

- Owns:
  - `defineFeature` and `defineExtension` for the server, `defineWebFeature` and `defineWebExtension` for the web
    app, and the checks hub-core runs on them at start;
  - the sockets a feature can fill, listed below;
  - the entitlement gate in front of every extension part;
  - the layout and rules of `ee/`.
- Does not own: what a feature does, for example the debugger's breakpoints and snapshots; which features the app
  ships and in what order: [app](app.md).
- Constraints:
  - A feature imports only `@micafox/hub-core` (`.`, `./web`, `./schema`), `@micafox/protocol`, `@micafox/ui` and
    its own dependencies; never another feature and never `ee/`. Features talk to each other through
    [events](server.md#events).
  - An extension may also import features, to extend them.
  - A feature's server part never reaches the web bundle: it lives behind the package's `.` entry, the web part
    behind `./web`.

## Interactions

```text
┌──────── @micafox/hub-debugger ────────┐                    ┌──────────── @micafox/hub-core ─────────────┐
│ .      defineFeature({ ... })         │───── features ────▶│ createHub(): registry · routes · migrator  │
│ ./web  defineWebFeature({ ... })      │                    │ jobs · retention · SDK module routing      │
└───────────────────────────────────────┘                    │                                            │
┌──────── @micafox/hub-ee (#ee) ────────┐                    │ entitlement gate in front of each part     │
│ .      defineExtension({ features })  │──── extension ────▶│ web shell: nav · route tree · slots        │
│ ./web  defineWebExtension({ ... })    │                    └────────────────────────────────────────────┘
└───────────────────────────────────────┘
```

### Server part

```ts
import { defineFeature } from "@micafox/hub-core";

export const debuggerFeature = defineFeature({
  name: "debugger", // unique; routes under /api/v1/debugger, events named "debugger.*"
  server: routes, // a Fastify plugin, registered encapsulated under /api/v1/<name>
  internal: uiRoutes, // optional; UI-only routes under /api/internal/<name>, not public API
  migrations: [m0001], // migration modules in order, forward-only
  jobs: [{ name: "expire-breakpoints", everyMs: 60_000, run: expire }],
  retention: [{ name: "snapshots", maxAgeDays: 30, run: deleteSnapshots }],
  protocol: { module: "debugger", state, onMessage }, // the SDK module this feature serves
});
```

- `server` and `internal` get a request context with the actor, the organization and a
  [scoped database](database.md#scoping-a-query), and publish [events](server.md#events).
- `jobs` run under an advisory lock, one run at a time across replicas: [jobs](server.md#jobs).
- `retention` declares how long the feature keeps its data; hub-core runs each policy as a job, and an operator
  overrides the defaults with `MICAFOX_RETENTION_<NAME>_DAYS`.
- `protocol` is how the feature serves its SDK module: `state(session)` returns the messages that bring an
  instance up to date, sent after `welcome` and on every resend; `onMessage(session, message)` handles a message of
  the module: [SDK endpoint](sdk-endpoint.md#routing-a-message).

### Web part

```ts
import { defineWebFeature } from "@micafox/hub-core/web";

export const debuggerWeb = defineWebFeature({
  name: "debugger",
  nav: [{ label: strings.nav, to: "/p/$projectId/e/$environmentId/debugger", icon: Bug, order: 10 }],
  routes: [breakpointsRoute, snapshotRoute], // children of the environment route
  slots: { "environment.overview": AppsCard },
  events: { "debugger.snapshot.created": (event) => [["debugger", "snapshots", event.environmentId]] },
});
```

- `nav` adds entries to the shell's navigation; `routes` adds TanStack Router routes under the environment, project
  or settings layout; `slots` fills named places in the shell's screens.
- `events` maps an [event](web.md#pushing-a-live-update) to the queries it makes stale.
- Slots in S2: `environment.overview`, `project.settings`, `org.settings` and `account.settings`.

### Extension

`defineExtension({ features })` and `defineWebExtension({ features })` take features of the same shape, each with an
`entitlement`. hub-core checks `entitlements(orgId).has(entitlement)` in front of every part of them: routes answer
403 with the problem type `entitlement-required`, jobs skip organizations without it, the SDK module is left out of
`welcome`, and the web part is hidden or shows an "Upgrade" placeholder. Core features have no entitlement and are
always on. Why the server decides:
[ADR 0024](../../adr/hub/access/0024-gate-paid-features-by-entitlements-on-the-server.md).

## Layout

```text
hub/core/src/server/feature/
├── index.ts          defineFeature, defineExtension and their types
├── registry.ts       checks the features at start and orders their parts
└── gate.ts           the entitlement gate for extension parts
hub/core/src/web/feature/
├── index.ts          defineWebFeature, defineWebExtension and their types
└── compose.ts        builds the navigation, the route tree and the slots from the features
hub/core/src/schema/
└── index.ts          TypeBox schemas the core's server and web share: the ./schema entry
hub/<feature>/src/
├── server/index.ts   the feature's server part
├── web/index.ts      the feature's web part
├── schema/index.ts   TypeBox schemas both parts use
└── migrations/       0001-<name>.ts, ...
ee/
├── LICENSE           the proprietary, source-available terms of everything under ee/
├── README.md         what ee/ holds, and that it takes no outside pull requests
└── hub/src/
    ├── server/index.ts   the server extension; empty in S2
    └── web/index.ts      the web extension; empty in S2
```

## Key flows

### Registering features

1. `createHub()` gets the server features in their order and the extension, from [the app](app.md).
2. The registry checks them: unique names, each SDK module served by one feature, unique migration, job and retention names.
   A failed check stops the start with exit code 1 and names the parts in conflict.
3. It hands the migrations to the [migrator](database.md#migrating) in order (core, the features, the extension),
   registers each feature's routes as an encapsulated Fastify plugin, the jobs and retention policies with the
   scheduler, and the protocol modules with the [SDK endpoint](sdk-endpoint.md).
4. In the browser, `compose.ts` builds the navigation, the route tree and the slots from the web features and the
   web extension.

### Adding a feature

1. Create `hub/<name>` (`@micafox/hub-<name>`) with the layout above and the AGPL licence, depending on hub-core,
   ui and protocol.
2. Add it to `hub/app/src/features.ts` and `src/web/features.ts`; its place in the list is its place in the
   migration order.
3. Its tables carry `org_id` under row-level security, or the start fails: [database](database.md#migrating).

## Decisions

- [0022. Split the hub into packages by role](../../adr/packages/0022-split-the-hub-into-packages-by-role.md)
- [0024. Gate paid features by entitlements on the server](../../adr/hub/access/0024-gate-paid-features-by-entitlements-on-the-server.md)
