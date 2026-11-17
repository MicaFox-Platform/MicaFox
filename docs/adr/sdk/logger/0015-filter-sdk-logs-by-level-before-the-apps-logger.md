# 0015. Filter SDK logs by level before the app's logger

## Status

Accepted · 2026-10-29

## Context

The SDK logs from its hottest paths: the pause handler, inside a 10 ms budget, and `send()`. Operators need to turn
on debug lines in a deployment through an environment variable instead of a code change, also when the app uses
the default `console`. A logger passed by the app filters by its own level, but only after the SDK has built the
line and called it.

## Decision

We filter SDK lines by `logLevel` inside the SDK, before the app's logger is called, for the default `console` and
a passed logger alike. The level comes from the option, then `MICAFOX_LOG_LEVEL`, then `warn`.

## Alternatives

- **Leave filtering to the app's logger** — every disabled line is still built and passed on the pause path, and
  the default `console`, which has no level, would print every debug line.
- **A level per component** — more options and environment variables for a need no user has shown.

## Consequences

- A disabled line costs one comparison, and hot paths skip building it.
- `MICAFOX_LOG_LEVEL=debug` shows debug lines with any logger, without a code change.
- A passed logger set to `debug` still receives only `warn` and `error` until `logLevel` is lowered too.
- `logLevel` and `MICAFOX_LOG_LEVEL` are public API.
