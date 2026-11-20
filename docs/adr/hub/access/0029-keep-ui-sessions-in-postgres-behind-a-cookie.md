# 0029. Keep UI sessions in Postgres behind a cookie

## Status

Accepted · 2026-11-20

## Context

People log in to the web app with an email and a password. An admin must be able to remove a member, and a user to
log out everywhere, with immediate effect. The hub serves the web app from its own origin. SSO arrives later from
`ee/` and should not change how a logged-in user is recognized. Self-hosted hubs should need no extra service.

## Decision

We keep UI sessions in Postgres: a random id in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie named
`__Host-micafox_session`, its SHA-256 in the `sessions` table, valid for 7 days without use and 30 days at most,
and we reject changing requests whose `Origin` is not the hub's.

## Alternatives

- **Stateless JWT** — cannot be revoked without a denylist, which brings the database back; logging out everywhere
  and removing a member become workarounds.
- **An external OpenID Connect provider only** — self-hosted teams would run Keycloak or similar just to log in.
- **Tokens in `localStorage`** — readable by any script that runs in the page.

## Consequences

- Every request costs one indexed lookup; logging out, logging out everywhere and removing a member take effect at
  the next request.
- The hub needs HTTPS outside `localhost`, where the cookie is `micafox_session` without `Secure`; it refuses to
  start on HTTP for any other host.
- Personal API tokens for the CLI and MCP are bearer tokens of [ADR 0030](0030-use-opaque-prefixed-tokens-stored-as-hashes.md)
  and skip the origin check.
- SSO creates the same session after its provider confirms the user.
