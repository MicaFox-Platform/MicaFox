# Hub SDK endpoint

## Purpose

The WebSocket in `@micafox/hub-core` that every SDK connector opens: the hub's side of the
[protocol](../protocol.md). It authenticates the app by its project key, agrees on modules, hands each module's
messages to the feature that serves it, and sends each instance the state its features keep for it.

## Boundaries

- Owns:
  - `wss://<hub>/sdk`: the key check before the upgrade, the `hello` → `welcome` handshake, limits, liveness;
  - the open sessions of a replica, by environment and instance;
  - connected instances: the `instances` table, whether each is online, and their API;
  - routing module messages to features, and resending a feature's state to an environment;
  - closing sessions when a key is revoked, entitlements change or the hub stops.
- Does not own: message types and wire rules: [protocol](../../api/protocol.md); what a module's messages mean, such
  as breakpoints and snapshots: its feature; keys: [access](access.md#managing-project-keys).
- Constraints:
  - Keeps the protocol as it is: nothing before `welcome`, `welcome` within 10 s of `hello`, frames up to 1 MiB,
    pings answered. No protocol change.
  - Never trusts the SDK: every frame is checked before a feature sees it, and every limit drops and counts what
    exceeds it.

## Interactions

```text
SDK connector                          SDK endpoint                              Feature, e.g. debugger
      │ GET /sdk, Bearer mfx_pk_…          │                                            │
      │───────────────────────────────────▶│ key hash → org, project, environment       │
      │◀────────── 101, or 401 403 429 503 │                                            │
      │ hello                              │                                            │
      │───────────────────────────────────▶│ version; modules served and entitled       │
      │◀──────────────────────── welcome   │                                            │
      │                                    │──────────── state(session) ───────────────▶│
      │◀──────────── module messages       │◀─────────── messages, e.g. breakpoints ────│
      │ batch, module messages             │                                            │
      │───────────────────────────────────▶│──────────── onMessage(session, message) ──▶│
```

## Layout

```text
hub/core/src/server/sdk-endpoint/
├── index.ts         the /sdk route
├── upgrade.ts       the key check and limits, and the HTTP answer before the upgrade
├── handshake.ts     the hello timer and checks, the welcome modules
├── sessions.ts      open sessions by environment, replacing and closing them
├── routing.ts       frames and batches to features, by module; depth and string checks; the counts
├── state.ts         a module's state after welcome and on a resend; `sdk.resend`
├── instances/       connected instances
│   ├── index.ts     `createInstances`: what the endpoint, the jobs and the routes use
│   ├── fields.ts    cutting the overlong fields of a hello
│   ├── online.ts    the sessions this replica holds, by environment and instance
│   ├── queries.ts   the upsert and its cap, last seen, expiry and the list
│   ├── routes.ts    `GET /api/v1/environments/{environmentId}/instances`
│   ├── schemas.ts   the route's query and reply
│   └── tables.ts    the `instances` table for Kysely
└── liveness.ts      the idle sweep and the per-session rate limit
```

## Key flows

### Connecting an SDK

1. The connector sends `GET /sdk` with `Authorization: Bearer <project key>`; the app's `MICAFOX_HUB_URL` is
   `wss://<hub>/sdk`, shown in the UI next to a new key.
2. The endpoint looks the key up by its SHA-256 hash ([access](access.md#managing-project-keys)) and caches a key
   it finds for 60 s, at most 10,000; the organization's entitlements have their own 60 s cache. A token without the
   key's format is refused without a lookup. A revoke drops the key from the cache, and for 60 s neither caches nor
   accepts it, even from a lookup that was running. Before any upgrade it answers, with a problem body and a
   `detail`:
   - 401 without a bearer token, except in [test mode](server.md#running-in-test-mode), where a connection
     without one joins the seeded environment; 403 for an unknown or revoked key; the SDK then waits its longest
     delay;
   - 429 over `MICAFOX_SDK_MAX_CONNECTIONS` (1000 per replica) or `MICAFOX_SDK_MAX_CONNECTIONS_PER_KEY` (500);
   - 503 while the hub is not ready, or when Postgres is down and the key is not cached; the SDK backs off as usual.

   A connection counts toward the limits from this check until its socket closes. An upgrade to any other route is
   answered over HTTP, 404 or the readiness gate's 503, and its socket closed
   ([ADR 0041](../../adr/hub/sdk-endpoint/0041-accept-sdk-websockets-with-fastify-websocket.md)).

3. After the upgrade the endpoint waits 10 s for `hello`. No `hello` in that time, another first frame or an invalid
   `hello` closes with `protocolError`; `hello` is checked by its structure, so fields a later v1 SDK adds pass. A
   `welcome` the hub cannot send within those 10 s, or when the entitlements cannot be read, closes with 1011; a
   `version` the hub has no types for closes with `incompatibleVersion`. A frame larger than
   `MICAFOX_SDK_MAX_FRAME_BYTES`, 1 MiB by default and raised when apps raise the SDK's `buffer.maxBytes`, closes with 1009.
4. It answers `welcome` at once with the modules of `hello` that a registered feature serves, without extension
   modules the organization is not entitled to.
5. It registers the session: instance, organization, project, environment, key and modules, with the rest of
   `hello`, and [keeps the instance](#keeping-instances). An open session with the same `instanceId` in the same
   environment is closed with 1001; an `instanceId` from another environment never replaces one. An `instanceId`
   longer than 64 characters makes the `hello` invalid.
6. For each agreed module it sends what the feature's `state(session)` returns, such as the full breakpoint list.
   It notes the key's last use, at connect and at every ping; the job `core.write-key-last-use` writes the noted
   uses every minute and keeps them for the next run when the write fails.

### Routing a message

1. Each frame must be UTF-8 JSON of a protocol message or a `batch`, in the session's version, nested at most 64
   levels deep; otherwise the session closes with `protocolError`. A batch holds messages, never a batch, and is
   handled message by message, in order.
2. NUL characters and unpaired surrogates in strings and property names, which Postgres cannot store, are replaced
   with U+FFFD and counted, so no message can stall the [write queue](database.md#writing-in-batches).
3. A repeated `hello`, a message without `module` (with a collapsed warning), a module the session did not agree on
   and an unknown one are ignored. Every other message goes to its feature's `onMessage(session, message)`, which
   checks it against its own schema.
4. A session may send `MICAFOX_SDK_MAX_MESSAGES_PER_SECOND` (1000) messages a second over 10 s: a bucket of ten
   seconds' worth that refills at the rate, one message of a batch each. The rest are dropped and counted, with a
   collapsed warning.
5. When `onMessage` throws, the error is logged, with a collapsed warning, and counted, and the session stays open.
6. A session's frames are handled one after another, each message after the `onMessage` before it settled. While a
   frame is being handled the socket is paused, so later frames wait in the kernel and the SDK's own buffer: the hub
   keeps only what one read of the socket completed, about 64 KiB and at most one frame of
   `MICAFOX_SDK_MAX_FRAME_BYTES`. A slow feature slows its own SDK down and nothing else; a session that stays
   paused for 45 s is cut off as idle. A failure of the hub itself while routing closes the session with 1011.

### Resending the state

1. After a change commits, a feature calls `sdk.resend(environmentId, module)`, which looks up the environment's
   organization and publishes `sdk.state.resend` on the [bus](server.md#events) with `data: { module }`. It never
   throws: a resend that fails is logged, and the next one or the reconnect heals it. The events streams skip `sdk.*`
   events, so no browser sees them.
2. Each replica sends `state(session)` again to its sessions in that environment that agreed on the module.
3. The state is always complete, never a diff
   ([ADR 0010](../../adr/protocol/0010-send-the-full-breakpoint-set-on-every-change.md)), so a resend that is lost
   or overtaken is healed by the next one or by the reconnect. At most one `state(session)` per session and module
   is read at a time: asks that come meanwhile make one more read once it settles, and the read they overtook is
   not sent. A burst of resends costs two reads, and the last state sent is never older than the last ask.

### Keeping instances

1. Each `hello` upserts its instance into `instances`, keyed by environment and `instanceId`: service, labels,
   hostname, pid, SDK, runtime, the modules the session agreed on, commit, protocol version, the key's prefix and the
   connect time. Fields are cut to fit: service at 128 characters, hostname at 255, the first 32 labels with keys of
   at most 64 and values of at most 256 characters, SDK and runtime names and versions and the commit at 64, a `pid`
   that is not a positive 31-bit integer becomes 0. NUL characters and unpaired surrogates become U+FFFD. Each cut
   and each replacement is counted, with one collapsed warning, and the session stays. A write that fails is
   logged and the session stays without a row until it reconnects.
2. An instance is online while this replica holds a session for it; nothing in the table says so, so a crash or a
   lost database never leaves an instance online. A job writes `last_seen_at` of the online ones every minute, and a
   closed session writes it once more. A session that a newer one of the same instance replaced writes nothing and
   leaves the instance online, and an older `hello` written late never overwrites a newer one.
3. A new instance beyond 1000 in an environment deletes the oldest offline one, never an online one; offline
   instances not seen for 7 days are deleted every hour.
4. `GET /api/v1/environments/{environmentId}/instances` (any member; `instance.read`) lists them with `online` and
   every `hello` field ([HTTP API](../../api/hub/http.md#instances)). `instance.connected`, once the row is
   written, and `instance.disconnected`, once the session has closed and the write of its last seen time has
   settled, keep the screens live; their `data` is `{ environmentId, instanceId }`. Features read instances through hub-core and keep
   their own per-instance data. Why:
   [ADR 0036](../../adr/hub/sdk-endpoint/0036-keep-connected-instances-in-hub-core.md).

### Keeping a session alive

1. The endpoint answers the SDK's pings. A session that sends nothing, not even a ping, for 45 s is terminated; one
   sweep every 5 s checks them all, so no timer is reset per frame.
2. A revoked key closes its sessions with 1008, and the reconnect gets 403.
3. A change of the organization's entitlements closes its sessions with 1001, so modules are agreed again.
4. When the hub stops, every session closes with 1001 ([stopping](server.md#stopping)).
5. A peer that does not answer a close the hub sends within 2 s is cut off, so it holds no slot and no stop waits on
   it; a connection the hub closes before its upgrade completes closes as soon as it does.

### Losing Postgres

1. Open sessions stay; keys in the cache still connect, and others get 503.
2. Writes wait in the bounded [write queue](database.md#writing-in-batches), and what does not fit is dropped and
   counted.
3. When `state(session)` fails, as it does when it cannot read the database, the session closes with 1011 and the SDK
   reconnects with backoff.

## Decisions

- [0006. Authenticate to the hub with a bearer token](../../adr/sdk/connector/0006-authenticate-to-the-hub-with-a-bearer-token.md)
- [0007. Deliver messages to the hub at most once](../../adr/protocol/0007-deliver-messages-to-the-hub-at-most-once.md)
- [0010. Send the full breakpoint set on every change](../../adr/protocol/0010-send-the-full-breakpoint-set-on-every-change.md)
- [0016. Use the hello's protocol version for the session](../../adr/protocol/0016-use-the-hellos-protocol-version-for-the-session.md)
- [0017. Tag messages with their module and agree on modules](../../adr/protocol/0017-tag-messages-with-their-module-and-agree-on-modules.md)
- [0030. Use opaque prefixed tokens stored as hashes](../../adr/hub/access/0030-use-opaque-prefixed-tokens-stored-as-hashes.md)
- [0036. Keep connected instances in hub-core](../../adr/hub/sdk-endpoint/0036-keep-connected-instances-in-hub-core.md)
- [0037. Start a seeded test mode on PGlite](../../adr/hub/server/0037-start-a-seeded-test-mode-on-pglite.md)
- [0041. Accept SDK WebSockets with @fastify/websocket](../../adr/hub/sdk-endpoint/0041-accept-sdk-websockets-with-fastify-websocket.md)
