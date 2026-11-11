# 0002. Ship the default connector inside the SDK

## Status

Accepted · 2026-10-21

## Context

The SDK needs a default transport to the hub, so every user of the SDK gets the default connector. Users who need
another transport implement the `Connector` interface from `@micafox/protocol` and do not need the default
one. The hub is the other end of the wire and needs only the protocol. The SDK and its default transport change
together. Beyond the protocol and Node built-ins, the default connector needs only `ws`
([ADR 0008](0008-use-websocket-for-the-hub-connection.md)) and the SDK's logger.

## Decision

We ship the default connector as a module of `@micafox/sdk` in `packages/sdk/src/connector/`, which imports
only `@micafox/protocol`, `ws`, the SDK logger and Node built-ins.

## Alternatives

- **A separate `@micafox/connector` package that the SDK depends on** — every user installs it anyway, the
  two packages would always be released together, and it adds a package to version, publish and document without a
  consumer other than the SDK.
- **A separate package that users install and pass to the SDK** — the SDK would not work without extra installation
  and wiring, which goes against making MicaFox easy to adopt.

## Consequences

- One package to install; the SDK works with the hub out of the box.
- The default connector and `ws` are installed with the SDK even when a user replaces the connector; `ws` has no
  dependencies of its own, so the cost is small.
- A tool that needs the transport without the debugger has to wait until the connector moves to its own package;
  the connector imports no SDK module but the logger, which imports none, so both can move together.
