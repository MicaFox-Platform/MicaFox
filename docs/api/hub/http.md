# Hub HTTP API

## Installation

The API lives at `<public URL>/api/v1`; its OpenAPI description is `GET /api/v1/openapi.json`. The web app calls it
with the session cookie; personal API tokens for scripts, the CLI and MCP tools arrive later as
`Authorization: Bearer mfx_pat_…`. Routes under `/api/internal` serve only the web app and may change at any time.

Conventions:

- JSON in and out; ids are UUIDs, times are ISO 8601 in UTC. A request body is at most 1 MiB.
- Every response carries `x-request-id`, the id the hub gives the request and logs it under; a client's own
  `x-request-id` is ignored.
- A changing request with the cookie must send an `Origin` equal to the hub's, as browsers do.
- Errors are `application/problem+json` (RFC 9457):

  ```json
  {
    "type": "urn:micafox:problem:validation",
    "title": "The request is not valid",
    "status": 400,
    "detail": "email: must match format \"email\"",
    "errors": [{ "path": "/email", "in": "body", "message": "must match format \"email\"" }],
    "requestId": "c0a8…"
  }
  ```

  `type` never changes once released: `validation` (400), `unauthenticated`, `session-expired`,
  `invalid-credentials` (401), `forbidden`, `origin-mismatch`, `entitlement-required` (403), `not-found` (404, also
  for what you may not see), `conflict` (409), `payload-too-large` (413), `rate-limited` (429), `not-ready` (503),
  `internal` (500).

  A `validation` problem lists the field that failed in `errors`: `path` is a JSON Pointer into the part of the
  request that `in` names, `body`, `query`, `params` or `headers`. Malformed JSON, an unsupported `Content-Type` or a
  malformed URL is a `validation` problem too; an unknown path or method is `not-found`. An `internal` problem never
  says what failed: quote its `requestId` to the hub's operator, who finds the error in the log.

- Lists take `?limit=` (1 to 200, default 50) and `?cursor=`, and answer `{ "items": [...], "nextCursor": "…" }`;
  `nextCursor` is missing on the last page.
- Compatible changes keep `/api/v1`: new endpoints, new fields, new optional parameters. Anything else goes to
  `/api/v2`, and `/api/v1` stays for one more minor version. Why:
  [ADR 0031](../../adr/hub/server/0031-version-the-http-api-in-the-path-errors-as-rfc-9457.md).

## Exports

### Setup

`POST /api/v1/setup` — `{ token, orgName, name, email, password }` creates the organization, its owner and a
session: 201 with the body of `GET /api/v1/session` and the session cookie. 403 `forbidden` for a wrong token, 429
`rate-limited` with `Retry-After`, and 404 once an owner exists. Passwords are 12 to 256 characters.

### Session

- `POST /api/v1/session` — `{ email, password }` logs in, sets the cookie and answers 200 with the body of
  `GET /api/v1/session`; 401 `invalid-credentials`, 429 `rate-limited` with `Retry-After` in seconds,
  also while an email waits: 1 s after its 5th failure, doubling to 60 s.
- `GET /api/v1/session` — `{ user: { id, name, email }, memberships: [{ orgId, orgName, role }] }`.
- `DELETE /api/v1/session` — logs out; `DELETE /api/v1/sessions` — logs out everywhere. Both answer 204 and clear
  the cookie.
- `PUT /api/v1/me/password` — `{ currentPassword, newPassword }`; answers 204 and ends every other session; 401
  `invalid-credentials` for a wrong current password, 429 `rate-limited` with `Retry-After` as at login.

The cookie is `__Host-micafox_session`, or `micafox_session` without `Secure` on `http://localhost`; a session ends
after 7 days without use or 30 days in all, and an expired one is 401 `session-expired`.

Setup, login and password change each let an IP make 100 attempts in 10 minutes, counted per route, malformed
requests included; an IPv6 address counts with its /64. The limits live in each replica's memory.

### Projects and environments

- `GET`, `POST /api/v1/orgs/{orgId}/projects` — list; create `{ name }` with a `production` environment (admins).
- `GET`, `PATCH /api/v1/projects/{projectId}` — read; rename `{ name }` (admins).
- `GET`, `POST /api/v1/projects/{projectId}/environments` — list; create `{ name }` (admins).
- `PATCH /api/v1/environments/{environmentId}` — rename `{ name }` (admins).

A project is `{ id, orgId, name, createdAt }` and an environment `{ id, projectId, name, createdAt }`; a create answers
201 and a rename 200 with it, and lists are pages ordered by name. Names are stored in Unicode NFC and trimmed, 1 to
64 characters, without control or invisible characters, and unique within their parent whatever their case; a taken
one is 409 `conflict`. A `cursor` the hub did not give is 400 `validation`. An organization, project or environment
the caller does not belong to is 404, as if it did not exist; a member who tries an admin action on one of theirs gets
403 `forbidden`; without a login, every route is 401 `unauthenticated`.

### Project keys

- `GET /api/v1/environments/{environmentId}/keys` — one page, oldest first and without `limit` or `cursor`, of
  `{ id, name, prefix, createdBy, createdAt, lastUsedAt }` for each active key (admins); never the token.
- `POST /api/v1/environments/{environmentId}/keys` — `{ name }` answers 201 with the key and, once, its `token`
  (`mfx_pk_` and 43 characters) for `MICAFOX_TOKEN` and the `hubUrl` for `MICAFOX_HUB_URL`: `wss://<hub>/sdk`, or
  `ws://` when the hub runs on plain HTTP; 409 `conflict` at 5 active keys (admins).
- `DELETE /api/v1/keys/{keyId}` — revokes the key and closes its SDK connections; answers 204 (admins).

`name` follows the rules of project names. `prefix` is the first 12 characters of the token, `createdBy` the id of the
user who made the key, or `null` once that user is gone, and `lastUsedAt` is `null` until an app connects. A revoked
key is gone from the list, and revoking it again is 404, as is a key or environment of an organization the caller
does not belong to; a member gets 403 `forbidden` on all three routes.

### Members and invites

- `GET /api/v1/orgs/{orgId}/members` — `{ userId, name, email, role }`.
- `PATCH`, `DELETE /api/v1/orgs/{orgId}/members/{userId}` — change the role `{ role: "admin" | "member" }`; remove
  (admins; never the owner).
- `POST /api/v1/orgs/{orgId}/members/{userId}/reset-link` — `{ url }`, a one-time link valid for an hour (admins).
- `GET`, `POST /api/v1/orgs/{orgId}/invites` — list; create `{ role }`, answered once with its `url`, valid 7 days
  (admins).
- `DELETE /api/v1/invites/{inviteId}` — revokes an invite (admins).
- `POST /api/v1/invites/accept` — `{ token, name, email, password }`, or `{ token }` while logged in; joins the
  organization.
- `POST /api/v1/password-resets/accept` — `{ token, password }`; ends the user's sessions.

### Entitlements

`GET /api/v1/orgs/{orgId}/entitlements` — `{ entitlements: string[] }`, the paid features the organization may use.

### Instances

`GET /api/v1/environments/{environmentId}/instances` — a page of the app instances that connected to the
environment in the last 7 days, online first, then by last seen: `{ id, online, service, labels, hostname, pid,
sdk: { name, version }, runtime: { name, version }, modules, commit, protocolVersion, keyPrefix, connectedAt,
lastSeenAt }`. `id` is the SDK's `instanceId`; the other fields come from its last
[`hello`](../protocol.md#hello), cut to the hub's limits. `?online=true` and `?service=` filter it.

### SDK endpoint

`GET /sdk` — the WebSocket an SDK opens (`MICAFOX_HUB_URL`) with `Authorization: Bearer <project key>`; after the
upgrade it speaks the [protocol](../protocol.md). Before the upgrade it answers with a problem: 401 `unauthenticated`
without a bearer token; 403 `forbidden` for a key that is unknown, revoked or not a project key; 429 `rate-limited`
over `MICAFOX_SDK_MAX_CONNECTIONS` or `MICAFOX_SDK_MAX_CONNECTIONS_PER_KEY` ([settings](config.md)); 503 `not-ready`
while the hub is not ready or cannot check the key. An upgrade to any other path is 404, or 503 `not-ready` while the hub is not ready.

After the upgrade the hub closes with `protocolError` (4400) when the first frame is not a valid `hello` or none comes
within 10 s, `incompatibleVersion` (4426) for a protocol version it does not know, 1009 for a frame over
`MICAFOX_SDK_MAX_FRAME_BYTES`, 1011 when it cannot answer `welcome`, 1008 when the key is revoked, and 1001 when the
same instance connects again in its environment, the organization's entitlements change, or the hub stops. A
connection that sends nothing, not even a ping, for 45 s is dropped.

Feature endpoints live under `/api/v1/<feature>/…` and are documented with each feature: [debugger](debugger.md).

## Usage

```sh
curl -c jar -H 'Origin: https://hub.example.com' -H 'Content-Type: application/json' \
  -d '{"email":"ann@acme.dev","password":"correct horse battery"}' \
  https://hub.example.com/api/v1/session
curl -b jar https://hub.example.com/api/v1/session
```
