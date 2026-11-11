# 0018. Expire breakpoints in the SDK by a time left from the hub

## Status

Accepted · 2026-11-11

## Context

A forgotten breakpoint keeps pausing a production app, within the rate limits, for as long as it is set. The hub
removes breakpoints by sending a new list, but breakpoints stay set while the hub is unreachable
([ADR 0007](0007-deliver-messages-to-the-hub-at-most-once.md)), so the hub alone cannot bound their life. The hub
sends the full list after every reconnect and on every change
([ADR 0010](0010-send-the-full-breakpoint-set-on-every-change.md)). App clocks can be wrong: containers with a
skewed clock, VMs resumed from suspend. Every hub, including custom ones, implements the rule. The protocol is not
published yet, so version 1 can still change.

## Decision

We give every breakpoint a required `expiresInMs`, the time it has left, which the hub computes on every send; the
SDK counts it down on a monotonic clock, at most 24 h, removes the breakpoint when it runs out, also without a hub,
and reports the status `expired`.

## Alternatives

- **Expiry in the hub only** — no protocol change, but a breakpoint stays set for as long as the hub is
  unreachable.
- **An absolute `expiresAt`** — repeating it is harmless, but the SDK compares it with the app's wall clock, so a
  skewed clock expires breakpoints early or late, and the 24 h cap still needs a count of its own in the SDK.
- **A fixed lifetime counted from when the SDK receives a breakpoint** — no hub logic, but every reconnect sends
  the list again and starts the count over, so a breakpoint on a flapping connection never expires.

## Consequences

- The latest list sets each breakpoint's time left, so the hub extends or shortens it by sending a new value; a
  change of `expiresInMs` alone does not touch V8.
- An expired `id` stays expired while it is listed, so the hub re-arms a breakpoint under a new `id`. The SDK
  reports `expired` when it happens and in reply to every list that still holds it, so a lost status comes back as
  ADR 0007 promises.
- ADR 0010's list is no longer the same bytes on every send: a hub computes `expiresInMs` each time and never
  replays a cached frame, or each reconnect would give every breakpoint its full time back.
- Expired entries hold no V8 breakpoint and no source map, and when every entry has expired the inspector's
  `Debugger` domain goes off, so a forgotten breakpoint costs the app nothing.
- A restart of the app, or `stop()` and `run()`, forgets which ids expired; the hub's next list decides again.
