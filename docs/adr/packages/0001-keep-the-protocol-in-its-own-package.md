# 0001. Keep the protocol in its own package

## Status

Accepted · 2026-10-21

## Context

The SDK and the hub are separate programs that talk only through messages carried by a connector, so both of them
and every connector must agree on the message types, the protocol version and the `Connector` interface. The SDK
ships a default connector; users can replace it with their own. The hub runs outside the host app and must not need
debugger runtime code. Whatever holds these types is public API, and changes to it decide whether old and new peers
still understand each other.

## Decision

We keep the message types, `PROTOCOL_VERSION`, `CLOSE_CODES`, the `Connector` interface and the data types carried
in messages in `@micafox/protocol`, a package of types and constants with no runtime logic and no
dependencies that every side depends on. It holds only what both ends of the wire must agree on.

## Alternatives

- **Types in `@micafox/sdk`** — the hub and custom connectors would install the debugger runtime to get the
  message types and the `Connector` interface, and every SDK release would look like a protocol change.
- **A general `@micafox/shared` for anything two packages use** — helpers and internal types would pile up
  next to the protocol, every change would touch all packages, it would be unclear which changes break
  compatibility, and all of it would become public API.

## Consequences

- The SDK, custom connectors and the hub import `@micafox/protocol` and never each other for protocol types.
- A protocol change is a change to this one small package, and it either keeps `PROTOCOL_VERSION` or adds the next
  version's module next to the old ones.
- Small helpers used by several packages are duplicated or kept in their owner instead of being shared here.
- One more package to version and publish.
