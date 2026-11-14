# 0006. Authenticate to the hub with a bearer token

## Status

Accepted · 2026-10-21

## Context

A production hub can set breakpoints in every connected app and receives their snapshots, so it must accept only
apps it trusts. MicaFox is self-hosted and should be easy to adopt: setting up a connection should take one secret,
set per deployment like `MICAFOX_HUB_URL`. The secret must not leak through logs, URLs or plain-text connections,
and it must be possible to rotate it without downtime.

## Decision

We authenticate the SDK with a bearer token from the `token` option or `MICAFOX_TOKEN`, sent in the
`Authorization: Bearer` header of the WebSocket upgrade request; the hub rejects a missing or invalid token with
HTTP 401 or 403 before the connection opens.

## Alternatives

- **Token in the URL query** — URLs end up in proxy, load balancer and access logs.
- **Token in the `hello` message** — the hub accepts an unauthenticated socket first, and a rejection arrives only
  after the upgrade.
- **mTLS** — certificates to issue, rotate and mount for every app, too much for adopting MicaFox; it can be added
  later next to the token.
- **No authentication** — anyone who can reach the hub could take snapshots of any connected app.

## Consequences

- Authentication adds one environment variable, `MICAFOX_TOKEN`, next to `MICAFOX_HUB_URL`; it is public API.
- The connector never logs the token, always verifies TLS certificates, follows no redirects, and refuses to send
  the token over `ws://` to a host other than `localhost`, `127.0.0.0/8` or `[::1]`, matched by name without a DNS
  lookup.
- To rotate a token without downtime, a hub accepts the old and the new token at once.
- The token proves the app to the hub; TLS proves the hub to the app.
