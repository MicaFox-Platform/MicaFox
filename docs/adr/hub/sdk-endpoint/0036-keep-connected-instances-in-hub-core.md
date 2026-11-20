# 0036. Keep connected instances in hub-core

## Status

Accepted · 2026-11-20

## Context

Every SDK instance introduces itself once per connection with `hello`: its id, service, labels, host, SDK, runtime,
modules and commit. Engineers need to see which instances are online, which went away and when, and the debugger
targets breakpoints by service and labels. `hello` is a session frame, not a module message, and error tracking and
logpoints will be modules over the same session. Features may not import each other, and the SDK endpoint already
holds the sessions in hub-core.

## Decision

We keep connected instances in hub-core: the SDK endpoint writes an `instances` row from each `hello`, derives online
from its open sessions, and serves them at `GET /api/v1/environments/{environmentId}/instances`; features read
instances from hub-core and add their own per-instance data.

## Alternatives

- **The debugger keeps its instances** — the next module would need its own copy filled from the same `hello`, since
  features cannot import each other, and two lists of the same apps would disagree.
- **Sessions in memory only** — no last seen, no offline instances, and snapshots could not show where they came
  from once an instance is gone.

## Consequences

- One instances API for every module, under the core HTTP API; the debugger's screens show it and add statuses.
- Online comes from the sessions of the replica that holds them; several replicas will need the socket owner's
  answer through the event bus.
- hub-core bounds the table: offline rows are deleted after 7 days, at most 1000 per environment, and long `hello`
  fields are cut.
