# 0010. Send the full breakpoint set on every change

## Status

Accepted · 2026-10-23

## Context

The hub decides which breakpoints each app instance has, and they change while the app runs. The connection drops
and comes back at any time, and a message lost with it is not resent in either direction
([ADR 0007](0007-deliver-messages-to-the-hub-at-most-once.md)). Every hub, including custom ones, implements this
exchange. An instance holds at most 100 breakpoints.

## Decision

We send the complete list of an instance's breakpoints in one `breakpoints` message right after every `welcome`, an
empty list included, and on every change; the SDK makes its breakpoints match the latest list it received.

## Alternatives

- **Add and remove messages, with the full list after `welcome`** — stays in sync, since changes are lost only
  with the connection and the list after the reconnect repairs that. But every hub implements three messages and
  the rule for when to send which, tracks what each instance already has, and a hub on several nodes must order
  its changes. It saves bytes only: a list of 100 breakpoints is typically about 20 KB and at most about 140 KB,
  well under the 1 MiB frame limit, and costs about as much to apply as one change, because the SDK touches V8
  only for the entries that differ.
- **Changes with acknowledgements and resends** — keeps the SDK in sync, but adds sequence numbers, timers and
  resend state to every hub and to the SDK, for at most 100 small records.

## Consequences

- The message is idempotent: receiving it twice, or after a reconnect, gives the same result.
- A hub needs no per-instance state beyond the list it wants the instance to have.
- Each change costs one message of up to 100 breakpoints. If the limit grows to thousands, add and remove messages
  need a new `PROTOCOL_VERSION`: an older SDK ignores message types it does not know and would miss the changes.
- The SDK compares the new list with its current breakpoints by `id`, touches V8 only for entries that differ, and
  sends a status for every listed breakpoint; the limits on the list are in the protocol API.
