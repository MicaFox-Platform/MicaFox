# 0005. Batch and rate-limit messages in the connector

## Status

Accepted · 2026-10-21

## Context

The debugger can produce bursts of messages, for example a breakpoint in a hot loop. One frame per message wastes
the network and loads the hub; one frame with thousands of messages stalls the socket and the hub. The host app's
network must not be saturated by MicaFox. Custom connectors use other transports, which frame messages their own
way. Every hub, including custom ones, has to read whatever framing the SDK sends.

## Decision

We batch and pace outgoing messages inside `HubConnector`: several messages go as one protocol `batch` frame, which
every hub accepts alongside single messages, within the public `batch.*` and `rateLimit.bytesPerSecond` options.
`Connector.send()` keeps taking one message.

## Alternatives

- **Batching in the SDK, with `Connector.send(messages)`** — every transport would be tied to array framing, and
  the rate limit would sit in the debugger, away from the network it protects.
- **A bare JSON array of messages as the frame** — a frame would no longer be one object with `version` and `type`,
  so a hub could not tell a batch from a malformed frame or check its version before reading the items.
- **No batching** — one frame per message, so bursts cost the most exactly when the host app is busiest.

## Consequences

- Frame count and outgoing bandwidth are bounded, whatever the debugger produces.
- A message waits up to `batch.flushIntervalMs` for its batch, and longer while the rate limit or a slow socket
  holds the queue.
- Custom connectors decide on batching themselves and may send `batch` frames or single messages.
- Every hub must handle `batch`: it is part of protocol version 1, and a hub that ignored it as an unknown type
  would lose most snapshots.
