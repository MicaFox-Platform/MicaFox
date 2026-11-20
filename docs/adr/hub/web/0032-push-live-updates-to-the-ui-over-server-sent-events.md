# 0032. Push live updates to the UI over server-sent events

## Status

Accepted · 2026-11-20

## Context

Engineers watch snapshots arrive, breakpoint statuses change and apps go offline while they debug, so screens must
update within a second without reloading. Updates only flow from the hub to the browser. The browser already holds
a session cookie for the same origin, and the hub runs behind reverse proxies that the operator chooses.

## Decision

We push live updates over server-sent events: the web app keeps one `EventSource` on `/api/internal/events`, which
sends events of the user's organizations as hints of what changed, and the app reloads the affected data through the
HTTP API.

## Alternatives

- **WebSocket for the UI** — two-way traffic is not needed, and a second WebSocket endpoint needs its own protection
  against cross-site WebSocket hijacking.
- **Polling** — either updates arrive late or the hub serves many empty requests.

## Consequences

- The stream uses the session cookie; logging out everywhere ends it.
- Each connection starts with `reset`, which makes the app reload everything, so the hub keeps no event history to
  replay.
- Every event carries its organization, and the isolation test covers the stream.
- The stream moves into the public API when the CLI reads it.
