# 0008. Use WebSocket for the hub connection

## Status

Accepted · 2026-10-23

## Context

The SDK and the hub talk both ways: the hub pushes breakpoint changes that must reach running apps within seconds,
and the SDK streams snapshots back. Apps run behind NAT, in containers and in locked-down networks, so the SDK can
only connect outbound, and often only over HTTPS on port 443 through load balancers and ingresses. The connection
lives in someone else's production app: one long-lived connection, little overhead per message, few dependencies.
It also must never keep the host process alive, and it needs custom headers on connect for the token, pings to
detect dead connections and a limit on incoming frame size.

## Decision

We use one WebSocket per SDK instance, opened outbound by the connector to the hub, carrying JSON protocol
messages in text frames both ways. We implement it with the `ws` package and unref its socket.

## Alternatives

- **HTTP polling** — a breakpoint change reaches an app only on its next poll; low latency means many requests
  from every instance, each repeating headers and the token.
- **HTTP requests up, Server-Sent Events down** — two channels to authenticate, keep alive and tie to one session;
  a reconnect of either breaks the handshake.
- **gRPC bidirectional streaming** — needs `@grpc/grpc-js` and protobuf in the host app and a gRPC toolchain in
  every hub; HTTP/2 streams are often cut by proxies and load balancers.
- **Raw TCP or TLS with our own framing** — a non-HTTP port that firewalls block and ingresses do not route, and a
  framing format we would own.
- **Node's built-in WebSocket client instead of `ws`** — keeps the process alive while the socket is open, and has
  no pings and no custom headers in the standard API.
- **Our own client on `node:http` and `node:tls` instead of `ws`** — no dependency, but we would own an RFC 6455
  framing parser, its conformance tests and its security fixes.

## Consequences

- An app needs no open port and no inbound access; it works wherever a direct outbound HTTPS connection works.
  Networks that allow outbound traffic only through an HTTP(S) proxy are not supported: `HTTPS_PROXY` is ignored.
- A hub must accept WebSocket upgrades, and load balancers in front of it must allow them with an idle timeout
  longer than the 15 s ping interval.
- One runtime dependency in the host app: `ws`, which has no dependencies of its own. Its versions are pinned to a
  range and updated through dependency review; a vulnerability in `ws` is a vulnerability in MicaFox.
- The connector controls headers, pings, payload limits and compression, and turns compression off.
- Follow-up: add `ws` and `@types/ws` to `@micafox/sdk`.
