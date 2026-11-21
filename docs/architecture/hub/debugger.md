# Hub debugger

## Purpose

`@micafox/hub-debugger` is the hub's side of the SDK's `debugger` module. Engineers set breakpoints on repository
lines for the apps of an environment, see what each app instance made of them, and read the snapshots, in the browser
or through the [HTTP API](../../api/hub/debugger.md) that tests, the CLI and later MCP tools use.

## Boundaries

- Owns:
  - breakpoints: targeting, expiry, hit limits, the enabled switch, wire ids and their generations;
  - the status of each breakpoint on each instance, and their summary;
  - snapshots: intake, storage, limits, retention and deletion;
  - the `debugger` module's `state(session)` and `onMessage`, the routes under `/api/v1/debugger`, the debugger's
    screens, events, jobs and retention policy.
- Does not own: connected instances, their table and their API, which hub-core keeps for every module
  ([SDK endpoint](sdk-endpoint.md#keeping-instances)); the wire format ([protocol](../../api/protocol.md)); what the
  app captures and redacts ([SDK debugger](../sdk/debugger.md)).
- Constraints:
  - Works with every SDK that speaks protocol version 1, unchanged: hit limits, targeting and expiry are the hub's
    work, and nothing here changes `@micafox/protocol`.
  - Never trusts the SDK: a status or snapshot counts only for a breakpoint of the session's environment, in its
    current placement; anything else is dropped and counted.
  - Budgets on the `small` size: 50 snapshots a second sustained, snapshot lists and the viewer within 300 ms at p95
    with 10 000 snapshots on one breakpoint and 1 million in the organization, at most 64 KiB of hub memory per idle
    instance. `pnpm bench:hub` measures them with simulated instances that speak the protocol.

## Interactions

```text
┌─ Browser, tests, CLI ─┐ /api/v1/debugger/… ┌────────────────── @micafox/hub-debugger ──────────────────┐
│ breakpoints, statuses │───────────────────▶│ routes: create, change, delete; revision; limits          │
│ snapshots             │◀───────────────────│                                                           │
└───────────────────────┘ JSON, SSE events   │ breakpoints of each environment, cached in memory         │
┌─ SDK endpoint (core) ─┐ state, onMessage   │ state(session): the instance's list with wire ids         │
│ sessions, instances   │───────────────────▶│ intake: statuses and snapshots → checks → counters        │
│                       │◀───────────────────│                                                           │
└───────────────────────┘ sdk.resend(env)    │ jobs: expiry events, environment cap; retention           │
                                             └─────────────────────────────┬─────────────────────────────┘
                                                      db.forOrg, writer    │ rows
                                                                           ▼
                                  debugger_breakpoints · debugger_breakpoint_statuses · debugger_snapshots
```

### Data

Every table has `org_id` under [row-level security](database.md#scoping-a-query).

- `debugger_breakpoints`, one row per breakpoint: its environment, `file`, `line`, target (`service`, `labels`),
  capture `limits`, `hitLimit`, `hits`, `dropped`, `expiresAt`, `enabled`, `generation`, `placedGeneration`,
  `revision`, who created it and when.
- `debugger_breakpoint_statuses`, one row per breakpoint and instance: the instance's last status, its `message`,
  the generation it answered and when.
- `debugger_snapshots`, one row per hit that reached the hub: the breakpoint's id, `file` and `line`; the instance's
  id, service, labels, hostname and commit; the SDK's and the hub's times; `truncated`; `stack` and `variables` as
  `jsonb`.

- A breakpoint's **state** follows from its fields: `active` while enabled, before `expiresAt` and below `hitLimit`;
  otherwise `disabled`, `expired` or `done`, in that order.
- A breakpoint targets every instance of its environment, or only those whose `service` equals its `service` and
  whose labels hold every one of its `labels` with the same value.
- `file` is the path in the repository, with `/`, without `./` or a leading `/`, at most 1024 characters; `line`
  is 1-based.
- Snapshots copy what they need from the breakpoint and the instance, so they stay readable after both are gone.
  Lists are ordered by the hub's receive time, which also drives cursors, retention and the cap; the SDK's `time`
  is shown beside it.
- Snapshot lists never read `stack` or `variables`. Their keyset indexes are `(breakpoint_id, received_at desc, id)`
  and `(environment_id, received_at desc, id)`; lists filter by breakpoint and time, and a breakpoint's list also
  by instance.

### Limits

| Limit                               | Value                                   | Beyond it                                                   |
| ----------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Active breakpoints per environment  | 100, the most an SDK takes in one list  | creating or enabling one is 409 `conflict`                  |
| Hit limit                           | 1 to 1000, default 100                  | the breakpoint is `done`; later snapshots are dropped       |
| Expiry                              | 1 minute to 24 h from now, default 1 h  | 400 `validation`                                            |
| Snapshots taken in, per environment | `MICAFOX_DEBUGGER_SNAPSHOTS_PER_SECOND` | dropped and counted, shown as dropped on the breakpoint     |
| One snapshot                        | 80 KiB of JSON, values 12 levels deep   | dropped and counted; the SDK sends at most 64 KiB, 5 levels |
| Snapshots kept per environment      | `MICAFOX_DEBUGGER_MAX_SNAPSHOTS`        | the oldest are deleted every minute                         |
| Snapshot age                        | `MICAFOX_RETENTION_SNAPSHOTS_DAYS`, 30  | deleted every hour                                          |

At the defaults, 100 snapshots a second per environment over 10 s and 100 000 kept, an environment holds at most
about 8 GiB of snapshots and usually well under 1 GiB, since most are a few KiB and Postgres compresses `jsonb`.

### Routes

| Path, under `/p/$projectId/e/$environmentId` | Screen                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| `/debugger`                                  | breakpoints, with the dialog that creates one                  |
| `/debugger/breakpoints/$breakpointId`        | one breakpoint: settings, statuses per instance, its snapshots |
| `/debugger/snapshots`                        | every snapshot of the environment, deleted breakpoints' too    |
| `/debugger/snapshots/$snapshotId`            | the snapshot viewer                                            |
| `/debugger/apps`                             | connected apps                                                 |

The `DEBUGGER` navigation entry opens `/debugger`. The `environment.overview` slot gets two cards: connected apps
(online count, services) and breakpoints (active count, snapshots in the last hour).

### Screens

```text
┌─ PRODUCTION · DEBUGGER ──────────────────────────────────────────────────── [ APPS ] [ SNAPSHOTS ] [ NEW ] ─┐
│ FILTER [ src/orders…        ] STATE [ active ▾ ]                                                           │
│ FILE:LINE                        TARGET            STATE    INSTANCES                  HITS     EXPIRES    │
│ src/orders/checkout.ts:42        all               active   ● 3 active  ▲ 1 error      12/100   in 48 min  │
│ src/cart/total.ts:17             service=cart      active   ◌ 2 pending                0/100    in 59 min  │
│ src/auth/session.ts:88           region=eu         done     ● 4 active                 100/100  in 12 min  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ NEW BREAKPOINT ─────────────────────────────────┐
│ FILE       [ src/orders/checkout.ts            ] │
│ LINE       [ 42 ]                                │
│ SERVICE    [ any ▾ ]  LABELS  [ region=eu ] [+]  │
│ EXPIRES IN [ 1 h ▾ ]  HIT LIMIT [ 100 ]          │
│ ▸ CAPTURE LIMITS  depth 3 · items 20 · str 256   │
│                    [ CANCEL ] [ SET ]            │
└──────────────────────────────────────────────────┘
┌─ src/orders/checkout.ts:42 ──────────────────────────────────────── [ DISABLE ] [ EXTEND ] [ DELETE ] ─────┐
│ TARGET all · EXPIRES in 48 min · HITS 12/100 · DROPPED 0 · BY ann@acme · 10:02                             │
│ ┌─ INSTANCES ──────────────────────────────────────┐ ┌─ SNAPSHOTS ────────────────────────────────────┐    │
│ │ checkout-7d9f  3f9c2e1  ● active                 │ │ 10:14:03.120  checkout-7d9f  3f9c2e1  truncated│    │
│ │ checkout-a1b2  3f9c2e1  ● active                 │ │ 10:13:58.004  checkout-a1b2  3f9c2e1           │    │
│ │ checkout-c3d4  2b71e0a  ▲ error: no code at or   │ │ …                                 [ MORE ]     │    │
│ │                         after line 42            │ └────────────────────────────────────────────────┘    │
│ │ checkout-e5f6  3f9c2e1  ○ no answer              │                                                       │
│ └──────────────────────────────────────────────────┘                                                       │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ SNAPSHOT · 10:14:03.120 · checkout-7d9f · 3f9c2e1 ──────────────────────────────────── [ COPY JSON ] ─────┐
│ ┌─ STACK ─────────────────────────────┐ ┌─ VARIABLES ──────────────────────────────────────────────────┐   │
│ │ > placeOrder  src/orders/…ts:42:7   │ │ ▾ this            Checkout                                   │   │
│ │   handle      src/routes/…ts:18:3   │ │ ▾ order           Order                                      │   │
│ │   <anonymous> node:internal/…:1:1   │ │     id            "o-17"                                     │   │
│ └─────────────────────────────────────┘ │     total         129.5                                      │   │
│                                         │   ▸ items         Array(3)                                   │   │
│                                         │     password      ■ redacted                                 │   │
│                                         │     note          "Please deliver after 6 p…" (812 chars)    │   │
│                                         │   ▸ customer      Customer · more properties not captured    │   │
│                                         │ ▾ <closure scope> unavailable: not read in time              │   │
│                                         └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ PRODUCTION · CONNECTED APPS ──────────────────────────────────────────────────────────────────────────────┐
│ SERVICE   INSTANCE        HOST            LABELS      SDK     NODE    COMMIT    MODULES    LAST SEEN       │
│ checkout  1b4e…  ● online checkout-7d9f   region=eu   0.1.1   24.11   3f9c2e1   debugger   now             │
│ cart      9c0a…  ○ offline cart-55aa      region=us   0.1.1   22.13   2b71e0a   debugger   3 h ago         │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The instances summary counts the online instances that agreed on `debugger` and match the target: one chip per
  status that has any, errors first. A status the hub does not know shows as `unknown`. Offline instances keep their
  last status in the detail, greyed, and count nowhere.
- The variables tree opens one level at first and renders a node's children when it is opened; the whole snapshot
  comes in one request, at most 80 KiB. `redacted`, `unavailable` with its reason, a cut string with its full
  length, and an object with more properties than captured are each marked in place.
- Lists load 50 rows a page and add more on `[ MORE ]`; the breakpoints list filters by file and state, snapshots
  by breakpoint, instance and time.
- Empty states lead to the first snapshot: no instance yet shows the two lines of a new key and the code below; no
  breakpoint shows `[ NEW ]`; a breakpoint without snapshots says which instances are `pending` or in `error`.

```ts
import { micafox } from "@micafox/sdk";

micafox.run({ service: "checkout" }); // MICAFOX_HUB_URL and MICAFOX_TOKEN come from the environment
```

## Layout

```text
hub/debugger/src/
├── server/
│   ├── index.ts            debuggerFeature: routes, jobs, retention and the protocol module
│   ├── routes/             /api/v1/debugger: breakpoints, statuses, snapshots
│   ├── breakpoints/        targeting, wire ids and generations, limits, the per-environment cache
│   ├── intake/             statuses and snapshots from the SDK: checks, hit and environment counters, coalescing
│   └── jobs/               expiry events, the environment cap, flushing counters, retention
├── web/
│   ├── index.ts            debuggerWeb: navigation, routes, slots and event invalidations
│   ├── breakpoints/        the list, the new breakpoint dialog, the breakpoint screen
│   ├── snapshots/          the snapshot list, the viewer and its variables tree
│   ├── apps/               the connected apps screen and the overview cards
│   └── strings.ts          the debugger's UI strings
├── schema/index.ts         TypeBox schemas of the API, and of the SDK messages the intake checks
└── migrations/             0001-breakpoints-statuses-snapshots.ts
```

## Key flows

### Setting a breakpoint

1. A member sends `POST /api/v1/debugger/environments/{environmentId}/breakpoints`; the route checks the limits and
   inserts the breakpoint with generation 1 in `db.forOrg`.
2. After the commit it publishes `debugger.breakpoint.changed`, updates the environment's cache and calls
   `sdk.resend(environmentId, "debugger")` ([resending the state](sdk-endpoint.md#resending-the-state)).
3. For each session, `state(session)` takes the environment's active breakpoints from the cache, keeps those whose
   target matches the session's `service` and labels, oldest first, and sends them as one `breakpoints` message:
   `id` is the wire id `<breakpointId>.<generation>`, `expiresInMs` is computed now, capped at 24 h
   ([ADR 0018](../../adr/sdk/debugger/0018-expire-breakpoints-in-the-sdk-by-a-time-left-from-the-hub.md)). The cache
   is loaded on the first session of an environment and kept current by the feature's own changes; a breakpoint
   costs a few hundred bytes.
4. The SDK answers each listed breakpoint with a `breakpointStatus`. The intake keeps the latest status per
   breakpoint and instance in memory and writes the changed ones once a second through
   [`writer.upsert`](database.md#writing-in-batches); then it publishes `debugger.statuses.changed` for the
   environment, at most once a second.
5. An online, matching instance with no status for the current generation 10 s after its list was sent shows
   `no answer`.

### Taking in a snapshot

1. The [SDK endpoint](sdk-endpoint.md#routing-a-message) has already checked the frame, replaced NUL characters and
   unpaired surrogates, and passes each `snapshot` to `onMessage`.
2. The intake parses the wire id and finds the breakpoint in the session's environment cache. It drops the snapshot,
   counted by reason, when the id is malformed, the breakpoint is unknown, deleted or of another environment, or its
   generation is older than `placedGeneration`, the generation of the last change of `file`, `line` or `limits`.
   Snapshots of an expired or disabled breakpoint, captured before that, are kept.
3. It checks the hit counter: at `hitLimit` the snapshot is dropped. Otherwise `hits` grows by one in memory; on
   reaching `hitLimit` the breakpoint turns `done`, `debugger.breakpoint.changed` is published and the state is
   resent, so the SDKs remove it. Counters are written once a second and read back when the cache loads.
4. It takes a token from the environment's bucket, then checks the snapshot: at most 80 KiB, values at most 12
   levels deep, measured without recursion, then against the schema. A failure drops it, counted.
5. It adds the copies from the breakpoint and the [instance](sdk-endpoint.md#keeping-instances) and the receive time,
   and hands the row to the [writer](database.md#writing-in-batches); the environment's snapshot count grows by one.
6. Once a second at most per environment it publishes `debugger.snapshot.created` with the breakpoint ids, and the
   open screens refetch what those events make stale ([live updates](web.md#pushing-a-live-update)).

### Changing a breakpoint

1. `PATCH /api/v1/debugger/breakpoints/{breakpointId}` changes `enabled`, `expiresInMs`, `hitLimit`, `limits`,
   `file`, `line` or the target. When the body holds `revision` and it is not the current one, the answer is 409
   `conflict` with the current breakpoint, and the UI shows what changed and asks again. The web app always sends
   `revision`; scripts may leave it out.
2. Every accepted change bumps `revision`; the hub's own transitions (hits, `done`, expiry, generations) never do.
3. A change of `file`, `line` or `limits` bumps `generation` and sets `placedGeneration` to it, so the SDK places the
   breakpoint anew and snapshots from the old place are dropped.
4. Extending a breakpoint that has not expired keeps its generation: the next list carries the new `expiresInMs`.
   Extending or enabling one whose `expiresAt` has passed bumps `generation`, because the SDK keeps an expired id
   expired.
5. When the SDK reports `expired` for the current generation while `expiresAt` is more than 5 s away, such as after
   an extension that arrived late, the hub bumps the generation and resends, at most once per breakpoint every 30 s.
   Statuses for older generations are ignored.
6. Lowering `hitLimit` to `hits` or below makes the breakpoint `done`; raising it above `hits` makes it active
   again under the same generation, since a `done` breakpoint was removed, not expired.
7. Every change publishes `debugger.breakpoint.changed` and resends the state; two people editing at once both see
   the result through live updates.

### Expiring a breakpoint

1. The SDK expires each breakpoint by itself; the hub leaves expired ones out of every list.
2. The `expire-breakpoints` job runs every minute and publishes `debugger.breakpoint.changed` for those whose
   `expiresAt` passed since its last run, so open screens show them `expired`.

### Deleting

1. `DELETE /api/v1/debugger/breakpoints/{breakpointId}` deletes the breakpoint and its statuses and resends the
   state; its snapshots stay until retention, listed under the environment.
2. `DELETE /api/v1/debugger/snapshots/{snapshotId}` deletes one snapshot;
   `DELETE /api/v1/debugger/breakpoints/{breakpointId}/snapshots` deletes all of a breakpoint's, also after the
   breakpoint is gone. Deleting snapshots never lowers `hits`.

### Keeping snapshots within bounds

1. The `trim-snapshots` job runs every minute and deletes each environment's oldest snapshots above
   `MICAFOX_DEBUGGER_MAX_SNAPSHOTS`, in batches of 1000.
2. The `snapshots` [retention policy](features.md#server-part) deletes snapshots older than 30 days every hour.

### From a fresh hub to the first snapshot

1. The owner finishes [setup](access.md#creating-the-first-owner) and creates a project; it starts with
   `production`, and the hub opens its settings at a new key: `MICAFOX_HUB_URL` and `MICAFOX_TOKEN` to copy, and the
   SDK's install and start code.
2. The connected apps card shows the app online once its `hello` arrives, live.
3. `[ NEW ]` on the debugger screen takes a file and a line; the breakpoint screen shows each instance go from
   `pending` to `active`, or the `error` and its reason.
4. The first hit appears in the snapshot list within 2 s, and opens in the viewer.

### When something fails

- **The hub restarts** — SDKs keep their breakpoints and reconnect; each session gets the full list, with
  `expiresInMs` computed from `expiresAt`, and answers it with statuses.
- **Postgres is down** — open sessions stay; snapshots, statuses and counters wait in memory and the write queue,
  and what does not fit is dropped and counted. API calls that need the database answer 503 `not-ready`, which the
  screens show inline; a new session closes with 1011 when its environment's cache is not loaded.
- **A line maps nowhere** — the SDK reports `error` with its reason, or `pending` while no loaded file matches; both
  show per instance.
- **An instance never answers** — it shows `no answer` 10 s after its list was sent, and counts in the summary until
  it answers or goes offline.
- **A snapshot arrives after its breakpoint is deleted** — dropped and counted as `unknown-breakpoint`.
- **A key is revoked with live connections** — its sessions close with 1008 and their instances go offline; their
  snapshots stay.
- **A flood of snapshots** — the environment's bucket, the hit limit and the write queue each drop and count; the
  breakpoint screen shows how many were dropped.

## Decisions

- [0036. Keep connected instances in hub-core](../../adr/hub/sdk-endpoint/0036-keep-connected-instances-in-hub-core.md)
- [0010. Send the full breakpoint set on every change](../../adr/protocol/0010-send-the-full-breakpoint-set-on-every-change.md)
- [0018. Expire breakpoints in the SDK by a time left from the hub](../../adr/sdk/debugger/0018-expire-breakpoints-in-the-sdk-by-a-time-left-from-the-hub.md)
- [0017. Tag messages with their module and agree on modules](../../adr/protocol/0017-tag-messages-with-their-module-and-agree-on-modules.md)
- [0007. Deliver messages to the hub at most once](../../adr/protocol/0007-deliver-messages-to-the-hub-at-most-once.md)
