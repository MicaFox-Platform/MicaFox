# Hub SDK endpoint

## Purpose

The WebSocket in `@micafox/hub-core` that every SDK connector opens: the hub's side of the
[protocol](../protocol.md). It authenticates the app by its project key, agrees on modules, hands each module's
messages to the feature that serves it, and sends each instance the state its features keep for it.

## Boundaries

- Owns:
  - `wss://<hub>/sdk`: the key check before the upgrade, the `hello` → `welcome` handshake, limits, liveness;
  - the open sessions of a replica, by environment and instance;
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
packages/hub-core/src/server/sdk-endpoint/
├── index.ts         the /sdk route
├── upgrade.ts       the key check and limits, and the HTTP answer before the upgrade
├── handshake.ts     the hello timer and checks, the welcome modules
├── sessions.ts      open sessions by environment, replacing and closing them
├── routing.ts       frames and batches to features, by module, then type
└── liveness.ts      the idle timer and the per-session rate limit
```

## Key flows

### Connecting an SDK

1. The connector sends `GET /sdk` with `Authorization: Bearer <project key>`; the app's `MICAFOX_HUB_URL` is
   `wss://<hub>/sdk`, shown in the UI next to a new key.
2. The endpoint looks the key up by its SHA-256 hash ([access](access.md#managing-project-keys)) and caches the
   result, with the organization's entitlements, for 60 s. Before any upgrade it answers, with a problem body:
   - 401 without a bearer token; 403 for an unknown or revoked key; the SDK then waits its longest delay;
   - 429 over `MICAFOX_SDK_MAX_CONNECTIONS` (1000 per replica) or `MICAFOX_SDK_MAX_CONNECTIONS_PER_KEY` (500);
   - 503 while the hub is not ready, or when Postgres is down and the key is not cached; the SDK backs off as usual.
3. After the upgrade the endpoint waits 10 s for `hello`. Another first frame or an invalid `hello` closes with
   `protocolError`; a `version` the hub has no types for closes with `incompatibleVersion`. A frame larger than
   `MICAFOX_SDK_MAX_FRAME_BYTES`, 1 MiB by default and raised when apps raise the SDK's `buffer.maxBytes`, closes
   with 1009.
4. It answers `welcome` at once with the modules of `hello` that a registered feature serves, without extension
   modules the organization is not entitled to.
5. It registers the session: instance, organization, project, environment, key and modules, with the rest of
   `hello`. An open session with the same `instanceId` in the same environment is closed with 1001; an
   `instanceId` from another environment never replaces one.
6. For each agreed module it sends what the feature's `state(session)` returns, such as the full breakpoint list.
   It notes the key's last use; a job writes it every minute.

### Routing a message

1. Each frame must be UTF-8 JSON of a protocol message or a `batch`, in the session's version; otherwise the session
   closes with `protocolError`. A batch is handled message by message, in order.
2. A repeated `hello`, a message without `module` (with a collapsed warning), a module the session did not agree on
   and an unknown one are ignored. Every other message goes to its feature's `onMessage(session, message)`, which
   checks it against its own schema.
3. A session may send `MICAFOX_SDK_MAX_MESSAGES_PER_SECOND` (1000) messages a second over 10 s; the rest are
   dropped and counted, with a collapsed warning.
4. When `onMessage` throws, the error is logged and counted and the session stays open.

### Resending the state

1. After a change commits, a feature calls `sdk.resend(environmentId, module)`, which publishes an event on the
   [bus](server.md#events).
2. Each replica sends `state(session)` again to its sessions in that environment that agreed on the module.
3. The state is always complete, never a diff
   ([ADR 0010](../../adr/protocol/0010-send-the-full-breakpoint-set-on-every-change.md)), so a resend that is lost
   or overtaken is healed by the next one or by the reconnect.

### Keeping a session alive

1. The endpoint answers the SDK's pings. A session that sends nothing, not even a ping, for 45 s is terminated.
2. A revoked key closes its sessions with 1008, and the reconnect gets 403.
3. A change of the organization's entitlements closes its sessions with 1001, so modules are agreed again.
4. When the hub stops, every session closes with 1001 ([stopping](server.md#stopping)).

### Losing Postgres

1. Open sessions stay; keys in the cache still connect, and others get 503.
2. Writes wait in the bounded [write queue](database.md#writing-in-batches), and what does not fit is dropped and
   counted.
3. When `state(session)` cannot read the database, the session closes with 1011 and the SDK reconnects with backoff.

## Decisions

- [0006. Authenticate to the hub with a bearer token](../../adr/sdk/connector/0006-authenticate-to-the-hub-with-a-bearer-token.md)
- [0007. Deliver messages to the hub at most once](../../adr/protocol/0007-deliver-messages-to-the-hub-at-most-once.md)
- [0010. Send the full breakpoint set on every change](../../adr/protocol/0010-send-the-full-breakpoint-set-on-every-change.md)
- [0016. Use the hello's protocol version for the session](../../adr/protocol/0016-use-the-hellos-protocol-version-for-the-session.md)
- [0017. Tag messages with their module and agree on modules](../../adr/protocol/0017-tag-messages-with-their-module-and-agree-on-modules.md)
- [0030. Use opaque prefixed tokens stored as hashes](../../adr/hub/access/0030-use-opaque-prefixed-tokens-stored-as-hashes.md)
