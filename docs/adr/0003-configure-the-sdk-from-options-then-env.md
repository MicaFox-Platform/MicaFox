# 0003. Configure the SDK from options, then env

## Status

Accepted · 2026-10-21

## Context

Most apps start the SDK with `micafox.run()` and let it create the default connector. The hub URL, token, service,
labels, log level and whether MicaFox runs at all differ per deployment (local, staging, production) and are set by
whoever runs the app, often without touching its code. The same settings are also passed in code and in tests, and
a `HubConnector` can be created directly, sometimes twice in one process with different settings.

## Decision

We resolve each option once, from the value passed in code, then its `MICAFOX_*` environment variable, then the
default: `micafox` options at `micafox.run()`, `HubConnector` options in its constructor. Only values that differ per
deployment get an environment variable; the list is in the [SDK API](../api/sdk/overview.md#usage).

## Alternatives

- **Options only** — every app would repeat the same code to read the environment, and pointing an app at another
  hub would need a code change wherever that code was not written.
- **Environment only** — two connectors in one process could not differ, tests would have to change
  `process.env`, and code could not override what the environment says.
- **Environment before options** — a deployment variable would silently override a value the code passes on
  purpose, so a test or a second `HubConnector` could not use its own `url` while `MICAFOX_HUB_URL` is set.

## Consequences

- An app connects to a hub with no MicaFox code beyond `micafox.run()`.
- Environment variable names are public API: they are documented in `docs/api/` and renaming one is a breaking
  change.
- Changes to `process.env` after `micafox.run()`, or after a `HubConnector` is created, do not affect them.
