# Hub debugger API

## Installation

Part of the hub's [HTTP API](http.md): the same base URL, authentication, errors and pagination. Every member of an
organization may use it. Connected instances, which breakpoints target, are a core endpoint:
[instances](http.md#instances).

## Exports

### `Breakpoint`

```json
{
  "id": "6f1c2d9e-…",
  "environmentId": "0b7a…",
  "file": "src/orders/checkout.ts",
  "line": 42,
  "service": "checkout",
  "labels": { "region": "eu" },
  "limits": { "maxDepth": 3 },
  "hitLimit": 100,
  "hits": 12,
  "dropped": 0,
  "expiresAt": "2026-11-20T11:02:00Z",
  "enabled": true,
  "state": "active",
  "revision": 3,
  "createdBy": { "id": "…", "name": "Ann" },
  "createdAt": "2026-11-20T10:02:00Z",
  "updatedAt": "2026-11-20T10:05:00Z",
  "instances": { "active": 3, "error": 1, "pending": 0, "rateLimited": 0, "expired": 0, "unknown": 0, "noAnswer": 0 }
}
```

A breakpoint on a line of the repository, set in every instance of its environment that it targets.

- `file` — the path in the repository with `/`, at most 1024 characters; `./` and a leading `/` are removed.
- `line` — 1-based; a line without code moves to the next one with code, in the app.
- `service`, `labels` — the target: `null` and `{}` target every instance; otherwise an instance must have this
  `service` and every one of these labels with the same value. At most 32 labels.
- `limits` — [`CaptureLimits`](../protocol.md#capturelimits) of its snapshots; `{}` uses the SDK's defaults.
- `hitLimit` — 1 to 1000, default 100; `hits` counts the snapshots the hub accepted, and never goes down.
- `dropped` — snapshots the hub dropped for this breakpoint: over the hit limit, the environment's rate, or the
  size and depth limits.
- `state` — `active`, `disabled`, `expired` or `done` (hit limit reached), derived from the other fields.
- `revision` — grows on every change a person makes; send it back to detect a concurrent change.
- `instances` — online instances that run the debugger and match the target, by their last status;
  `noAnswer` counts those with no status 10 s after the hub sent them the breakpoint.

### Breakpoints

- `GET /api/v1/debugger/environments/{environmentId}/breakpoints` — a page of `Breakpoint`, newest first.
  `?state=active|disabled|expired|done` and `?file=` (a prefix) filter it.
- `POST /api/v1/debugger/environments/{environmentId}/breakpoints` —
  `{ file, line, service?, labels?, limits?, hitLimit?, expiresInMs? }` creates a breakpoint and answers 201 with it.
  `expiresInMs` is 60 000 to 86 400 000 (24 h), default 3 600 000. 409 `conflict` when the environment already has
  100 active breakpoints.
- `GET /api/v1/debugger/breakpoints/{breakpointId}` — one `Breakpoint`.
- `PATCH /api/v1/debugger/breakpoints/{breakpointId}` — any of
  `{ revision?, enabled?, expiresInMs?, hitLimit?, limits?, file?, line?, service?, labels? }`. `expiresInMs`
  sets a new expiry from now. With `revision`, a stale one answers 409 `conflict` with the current breakpoint in
  `current`; without it the change applies as is. Enabling or raising `hitLimit` past the 100 active ones is 409.
- `DELETE /api/v1/debugger/breakpoints/{breakpointId}` — removes it from every app; answers 204. Its snapshots stay
  until retention.

### Statuses

`GET /api/v1/debugger/breakpoints/{breakpointId}/statuses` — a page of
`{ instanceId, online, status, message?, current, updatedAt }`, one per instance that answered, plus
`status: "noAnswer"` for matching online instances that did not.

- `status` — `pending`, `active`, `rateLimited`, `expired`, `error`
  ([`BreakpointStatus`](../protocol.md#breakpointstatus)), `unknown` for one the hub does not know, or `noAnswer`.
- `message` — the reason of an `error`.
- `current` — `false` when the status is about an earlier placement of the breakpoint, before its `file`, `line` or
  `limits` changed.

### Snapshots

- `GET /api/v1/debugger/environments/{environmentId}/snapshots` — a page of snapshot summaries, newest received
  first: `{ id, breakpointId, file, line, instance: { id, service, labels, hostname, commit }, time, receivedAt,
truncated, sizeBytes }`. `?breakpointId=` and `?receivedBefore=` / `?receivedAfter=` filter it; with
  `breakpointId`, `?instanceId=` too. Snapshots of deleted breakpoints are listed.
- `GET /api/v1/debugger/snapshots/{snapshotId}` — the summary with `stack` and `variables` as in
  [`Snapshot`](../protocol.md#snapshot); `time` is the app's clock, `receivedAt` the hub's.
- `DELETE /api/v1/debugger/snapshots/{snapshotId}` — deletes one snapshot; 204.
- `DELETE /api/v1/debugger/breakpoints/{breakpointId}/snapshots` — deletes every snapshot of a breakpoint, also a
  deleted one; 204.

Snapshots are kept 30 days and at most 100 000 per environment, the oldest deleted first
([settings](config.md#settings)).

### Events

The web app's live updates carry `debugger.breakpoint.changed`, `debugger.statuses.changed` and
`debugger.snapshot.created`, each at most once a second per environment. They are not public API yet; scripts poll
the endpoints above.

## Usage

A test against a hub in [test mode](config.md#test-mode): log in as the seeded owner, set a breakpoint in the seeded
environment, wait for a snapshot. `HUB` and `ENV` come from the hub's `hub.started` line.

```sh
curl -c jar -H "Origin: $HUB" -H 'Content-Type: application/json' \
  -d '{"email":"owner@micafox.test","password":"'"$MICAFOX_TEST_PASSWORD"'"}' "$HUB/api/v1/session"
BP=$(curl -b jar -H "Origin: $HUB" -H 'Content-Type: application/json' \
  -d '{"file":"src/orders/checkout.ts","line":42,"hitLimit":1}' \
  "$HUB/api/v1/debugger/environments/$ENV/breakpoints" | jq -r .id)
until curl -b jar "$HUB/api/v1/debugger/environments/$ENV/snapshots?breakpointId=$BP" | jq -e '.items[0]'; do
  sleep 0.2
done
```
