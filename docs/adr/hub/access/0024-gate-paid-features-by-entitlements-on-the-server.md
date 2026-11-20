# 0024. Gate paid features by entitlements on the server

## Status

Accepted · 2026-11-20

## Context

The official image holds the paid features of `ee/` for everyone. Cloud sells them per organization through a
subscription; self-hosted companies will buy a licence key later. A self-hosted hub must not call home, and an
expired payment must not destroy data. The UI runs in the user's browser and can be changed by them.

## Decision

We check `entitlements(orgId).has(name)` on the server in front of every part of an extension (routes, jobs, the
SDK module in `welcome`, screens), with entitlements coming from sources: none in S2, a Cloud subscription, and a
licence key signed with ed25519 and checked offline against public keys built into the image; the UI only hides or
shows "Upgrade".

## Alternatives

- **Gate at build time, one image per customer** — contradicts one official image; every customer change is a new
  build.
- **Check licences online against our server** — self-hosted hubs would call home and stop working when it is down.
- **Gate in the UI only** — anyone can call the API directly.

## Consequences

- Core features are always on and never ask; only extension parts carry an `entitlement`.
- Entitlements are cached for 60 s next to verified project keys, so `welcome` needs no database round trip; a
  change closes the organization's SDK sessions with 1001 so modules are agreed again.
- An expired licence or subscription turns its features off and keeps their data.
- A licence key is a JSON payload with `kid`, features, seats and `expiresAt`; `kid` lets keys rotate. The key
  service, billing and `MICAFOX_LICENSE` come with their stages.
