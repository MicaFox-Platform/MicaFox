# Architecture overview

## Components

```text
┌──────────────────────────────── Host app (Node.js) ────────────────────────────────┐
│                              ┌────────────────── @micafox/sdk ───────────────────┐ │
│ ┌────┐ Debugger.*, Runtime.* │ ┌──────────┐    send(message)    ┌──────────────┐ │ │  hello, messages (wss)   ┌─────┐
│ │ V8 │◀──────────────────────┼─│ Debugger │────────────────────▶│ HubConnector │─┼─┼─────────────────────────▶│ Hub │
│ │    │───────────────────────┼▶│          │◀────────────────────│              │◀┼─┼──────────────────────────│     │
│ └────┘  scriptParsed, paused │ └────┬─────┘ onMessage, onStatus └──────┬───────┘ │ │  welcome, breakpoints    └─────┘
│                              │      │ log lines   ┌────────┐ log lines │         │ │
│                              │      └────────────▶│ Logger │◀──────────┘         │ │
│                              │                    └───┬────┘                     │ │
│                              └────────────────────────┼──────────────────────────┘ │
│ ┌───────────────────────┐                             │                            │
│ │ App logger or console │◀────────────────────────────┘                            │
│ └───────────────────────┘ debug|info|warn|error(message, context)                  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

The [SDK](sdk/overview.md) runs inside the host app as a set of modules over one
[connector](sdk/connector.md), `HubConnector` by default, which carries every module's messages to and from the hub
over one WebSocket; every module message names its module, and the handshake agrees on which modules a session
carries. The [debugger](sdk/debugger.md) is the SDK's only module: it sets breakpoints through the V8
inspector and captures snapshots of variables without stopping the app. The [logger](sdk/logger.md) writes the SDK's
own problems to the app's logger or `console`. The hub decides which breakpoints exist and receives the snapshots;
it is not part of this repository yet, and any server that speaks the [protocol](protocol.md) can act as one. Every
peer builds against the protocol.

What the host app can rely on:

- The SDK never throws into or crashes the app. An internal error turns MicaFox off; a lost hub connection is
  retried.
- Without breakpoints V8 runs the app as if MicaFox were not there; with them, pauses are short and capped per
  second. Every breakpoint expires after the time the hub gives it, at most 24 h, even while the hub is
  unreachable.
- Memory and traffic are bounded, and the process is kept alive only while `stop()` sends what is left, and
  briefly while the connector connects or closes a connection.
- Secrets are redacted by name inside the app; the hub cannot turn this off.

The exact limits: [SDK API](../api/sdk/overview.md#installation).

## Packages

- `@micafox/protocol` — messages, `PROTOCOL_VERSION` and the `Connector` interface; types and constants
  only. The SDK, custom connectors and hubs import it: [architecture](protocol.md), [API](../api/protocol.md).
- `@micafox/sdk` — the debugger, `HubConnector` and the logger, run in the host app. Depends on the protocol
  and `ws`: [architecture](sdk/overview.md), [API](../api/sdk/overview.md).
- `@micafox/configs` — shared TypeScript, ESLint, Prettier and Vitest presets; dev-time only, never in the
  host app: [architecture](configs.md), [API](../api/configs.md).

`examples/frameworks/fastify` is a demo app to try the SDK by hand: a Fastify server debugged by `micafox` under tsx,
with the kit's fake hub setting a sample breakpoint, and its end-to-end tests run both as real processes.
`examples/formats` runs the built SDK in one small app per format: plain JavaScript with `require()` and with `import`,
TypeScript compiled by tsc to CommonJS and to ES modules with `.map` files, and a bundle, which is not supported; its
tests run after the build. `examples/frameworks/express`, `nestjs` and `nextjs` run the built SDK in an Express app, a
NestJS app built by the Nest CLI and a Next.js app served by `next start`, where the SDK runs but breakpoints in the
bundled route handlers stay `pending`; their tests run after the build too. All the examples start their processes and
one fake hub through `tools/testkit` (`@micafox/testkit`), a private, never-published kit that only examples depend on:
[README](../../tools/testkit/README.md).

The protocol and the SDK ship as ES modules and CommonJS, so apps load them with `import` or `require()`.

## Key flows

One debugging session, end to end:

1. [Starting](sdk/debugger.md#starting) — `micafox.run()` resolves the options and creates the default connector,
   unless one is passed.
2. [Connecting](sdk/connector.md#connecting) — the connector opens the WebSocket and
   [opens a session](protocol.md#opening-a-session) with `hello` → `welcome`, which agree on the modules.
3. [Applying breakpoints](sdk/debugger.md#applying-breakpoints) — the hub sends the full breakpoint set; the
   debugger maps repository lines to loaded scripts and reports each breakpoint's status;
   [each expires](sdk/debugger.md#expiring-a-breakpoint) when its time runs out.
4. [Capturing a snapshot](sdk/debugger.md#capturing-a-snapshot) — a hit pauses the thread briefly, the variables
   are read within limits, [secrets are redacted](sdk/debugger.md#redacting-secrets) and the snapshot goes to the
   connector.
5. [Sending a message](sdk/connector.md#sending-a-message) — control messages first, snapshots buffered, batched
   and rate-limited.
6. [Losing the connection](sdk/debugger.md#losing-the-connection) — breakpoints stay set; after the reconnect the
   hub sends the full set again.
7. [Stopping](sdk/debugger.md#stopping) — `micafox.stop()` removes the breakpoints and closes the connector it
   created, sending buffered snapshots.

Throughout, every part [writes its problems](sdk/logger.md#writing-a-line) through the logger.

Changing the contract between peers: [changing the protocol](protocol.md#changing-the-protocol).

## Decisions

Every ADR, grouped by component, and the superseded ones: [ADR overview](../adr/overview.md). Each
component doc lists its own under Decisions.
