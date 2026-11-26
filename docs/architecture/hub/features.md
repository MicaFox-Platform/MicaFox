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
  jobs: [{ name: "expire-breakpoints", everyMs: 60_000, run: expire }], // run({ orgId, signal, log, forOrg, sdk })
  retention: [{ name: "snapshots", maxAgeDays: 30, run: deleteSnapshots }], // run({ orgId, olderThan, limit, db })
  protocol: { module: "debugger", state, onMessage }, // the SDK module this feature serves
});
```

- `server` and `internal` are plugins `(app, access)` registered inside the scope that has the actor, so a request
  is 401 before it reaches them. `access` is `inOrganization(request, orgId)`, `inOwningOrg(request, run)` and
  `requireCan(context, action)`, the core's own helpers: the context they give holds the actor, the membership and a
  [scoped database](database.md#scoping-a-query). `access.sdk.resend(environmentId, module)` sends the module's
  `state(session)` again to the environment's instances, once a change has committed: [resending the
  state](sdk-endpoint.md#resending-the-state). Features publish [events](server.md#events).
- A feature's name is lowercase letters, digits and dashes, and not one the core uses (`projects`, `keys`, `core`,
  `sdk`, ...), since its routes, its `<name>.<action>` grants and its migrations package take it.
- Jobs and retention `run` per organization: the scheduler calls them for each organization the gate lets through.
  A job's `run({ orgId, signal, log, forOrg, sdk })` gets `forOrg(run)`, which is `db.forOrg(orgId, run)`, a `log`
  with the job and the organization bound, and a `signal` that aborts at the run's time limit or when the hub stops:
  end the work at the next safe point. `sdk.resend(environmentId, module)` is the same as in routes. `everyMs` is a
  whole number of milliseconds up to 2³¹ − 1.
- `jobs` run under an advisory lock, one run at a time across replicas: [jobs](server.md#jobs).
- `retention` declares how long the feature keeps its data; hub-core runs each policy as a job, and an operator
  overrides the defaults with `MICAFOX_RETENTION_<NAME>_DAYS`. A policy's `run({ orgId, olderThan, limit, db })`
  deletes at most `limit` rows of the organization older than `olderThan` through `db`, a `db.system` transaction
  that sees every organization's rows, so it filters by `orgId`, and returns how many it deleted; the runner calls it
  again while a batch deletes `limit` rows: [keeping data within bounds](database.md#keeping-data-within-bounds).
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

`defineExtension({ features, sources? })` and `defineWebExtension({ features })` take features of the same shape,
each with an `entitlement`. `sources` are the extension's entitlement sources, `(orgId) => Promise<ReadonlySet<string>>`;
S2 has none, so every answer is no. hub-core checks `entitlements(orgId).has(entitlement)` in front of every part of
them, through the gate (`gate.isEntitled(orgId, feature)`, `gate.isModuleEntitled(orgId, module)`):

- routes answer 403 with the problem type `entitlement-required`: a route with `orgId` in its path is refused before
  its body is read, and any other asks inside `access.inOrganization` and `access.inOwningOrg`; a non-member is 404
  first, so nothing says the organization exists. `inOwningOrg` asks for each of the actor's organizations before
  any transaction, and refuses inside the transaction of the organization that holds the id, which rolls back what
  the route did there; a route must not act outside that transaction before it returns;
- jobs and retention skip organizations without it, and the SDK module is left out of `welcome`: the scheduler and
  the SDK endpoint ask the gate, with the registry's jobs and modules tagged by feature;
- the web part is hidden or shows an "Upgrade" placeholder.

Core features have no entitlement and are always on: the gate answers yes without asking a source. A source that
fails fails the question, so a request is 500 and a job fails; a paid part never runs on a doubt. Why the server decides:
[ADR 0024](../../adr/hub/access/0024-gate-paid-features-by-entitlements-on-the-server.md).

## Layout

```text
hub/core/src/server/feature/
├── index.ts          the entry: what the rest of the server imports
├── contract.ts       defineFeature, defineExtension and their types
├── registry.ts       checks the features at start and orders their parts
├── routes.ts         registers each feature's server and internal routes, encapsulated, behind the gate
└── gate.ts           the entitlement gate for extension parts
hub/core/src/web/feature/
├── index.ts          defineWebFeature, defineWebExtension and their types
└── compose.ts        builds the navigation, the route tree and the slots from the features
hub/core/src/schema/
├── index.ts          TypeBox schemas the core's server and web share: the ./schema entry
└── pagination.ts     the page query parameters and the page of every list
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
2. The registry checks them: unique names that are valid and not the core's, each SDK module served by one feature,
   unique job and retention names, no migration name twice in a feature, and an entitlement on each extension
   feature and on no other. A failed check stops the start, and `micafox-hub migrate`, with exit code 1 and one line
   per problem naming the parts in conflict.
3. It hands the migrations to the [migrator](database.md#migrating) in order (core, the features, the extension),
   each feature as its own package named after it, registers each feature's routes as an encapsulated Fastify
   plugin, and lists the jobs, retention policies and protocol modules, tagged with their feature, for the
   scheduler and the [SDK endpoint](sdk-endpoint.md): the hub hands them out as `hub.registry`, with `hub.gate`.
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
