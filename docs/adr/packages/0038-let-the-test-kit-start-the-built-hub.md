# 0038. Let the test kit start the built hub

## Status

Accepted · 2026-11-20

## Context

`tools/testkit` starts the processes of the examples' end-to-end tests, including a fake hub, and may depend only on
`@micafox/protocol`. The fake hub is to be replaced by the hub's [test mode](../hub/server/0037-start-a-seeded-test-mode-on-pglite.md).
The hub is private and never published, it needs a build step for its PGlite seed, and packages import each other
only by package name. `pnpm verify` must stay Docker-free.

## Decision

We let `tools/testkit` depend on the private `@micafox/hub` and start its built `micafox-hub` command, resolved through
the package's `./cli` export, in test mode.

## Alternatives

- **The hub's Docker image only** — Docker in `pnpm verify`, and an image build before every test run.
- **A path or environment variable to the hub** — a dependency pnpm cannot see, so the build order and filters
  break, and it goes around "by package name".

## Consequences

- The dependency table allows testkit → hub; nothing published depends on it, because testkit is never published.
- Example tests that start the hub need `pnpm build` first; the kit fails with that hint when the build is missing.
- The kit runs the default build; the basic hub's test mode is covered by the CI end-to-end job of both builds.
- `pnpm bench` keeps the fake hub, since it measures the SDK, not the hub.
