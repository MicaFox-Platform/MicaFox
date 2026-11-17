# 0016. Use the hello's protocol version for the session

## Status

Accepted · 2026-10-30

## Context

The SDK and hubs are released and upgraded independently: an app may run an older or newer SDK than its hub
expects, for months. A protocol version bump must not cut off every app until it is redeployed, and the SDK runs
inside someone else's app, so it should carry as little protocol code as possible. Every hub, including custom
ones, implements the rule.

## Decision

A session uses the protocol version of its `hello` for every message in both directions; a hub accepts every
version it still has types for and closes with `incompatibleVersion` otherwise, and the SDK speaks only its own
`PROTOCOL_VERSION`.

## Alternatives

- **Exact match with the hub's version** — a hub upgrade that bumps the version would cut off every app until it
  is redeployed.
- **Negotiation: the SDK lists the versions it speaks and the hub picks one** — the SDK would carry types and code
  for several versions inside the host app, while the hub can keep old versions' types at no cost to apps.

## Consequences

- Apps and hubs upgrade independently as long as the hub keeps the app's version.
- A hub keeps one module per version it accepts, `src/v<N>.ts` in `@micafox/protocol`.
- A message with another version than its session is a protocol error.
