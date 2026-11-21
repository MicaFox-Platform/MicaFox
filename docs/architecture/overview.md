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
any server that speaks the [protocol](protocol.md) can act as one, and every peer builds against the protocol.

The [hub](hub/overview.md) is one process: it serves the web app, the HTTP API under `/api/v1` and the SDK
endpoint `/sdk`, keeps its state in Postgres, isolates organizations with row-level security, and gains features,
such as the debugger's screens and storage, through one feature contract. Its open core is AGPL-3.0-only; paid
features live in `ee/` under their own licence and reach the official image through one `#ee` import, while CI builds
the open "basic hub" without them.

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
- The hub — private packages, never on npm, shipped as the image `ghcr.io/micafox-platform/hub`:
  `@micafox/ui` (MIT), `@micafox/hub-core`, `@micafox/hub-debugger` and the app `@micafox/hub` (AGPL-3.0-only), and
  `@micafox/hub-ee` in `ee/hub` (proprietary): [architecture](hub/overview.md#packages),
  [API](../api/hub/overview.md).

`examples/frameworks/fastify` is a demo app to try the SDK by hand: a Fastify server debugged by `micafox` under tsx,
with the kit's fake hub setting a sample breakpoint, and its end-to-end tests run both as real processes.
`examples/formats` runs the built SDK in one small app per format: plain JavaScript with `require()` and with `import`,
TypeScript compiled by tsc to CommonJS and to ES modules with `.map` files, and an esbuild bundle with one `.map`; its
tests run after the build. `examples/frameworks/express`, `nestjs` and `nextjs` run the built SDK in an Express app, a
NestJS app built by the Nest CLI and a Next.js app whose route handlers `next build` bundles, served by `next start`;
their tests run after the build too. All the examples start their processes and
one fake hub through `tools/testkit` (`@micafox/testkit`), a private, never-published kit that only examples depend on,
which also holds `pnpm bench`, the benchmark of the SDK's overhead: [README](../../tools/testkit/README.md). Once
the hub is built, the kit starts it in [test mode](hub/server.md#running-in-test-mode) from `@micafox/hub` in place of
the fake hub ([ADR 0038](../adr/packages/0038-let-the-test-kit-start-the-built-hub.md)); `pnpm bench` keeps the fake
hub, and `pnpm bench:hub` measures the hub with simulated instances.

The protocol and the SDK ship as ES modules and CommonJS, so apps load them with `import` or `require()`; the hub
packages are ES modules only.

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

On the hub's side: [connecting an SDK](hub/sdk-endpoint.md#connecting-an-sdk),
[resending the state](hub/sdk-endpoint.md#resending-the-state), [serving a request](hub/server.md#serving-a-request)
and [pushing a live update](hub/web.md#pushing-a-live-update); all of the hub's flows:
[hub overview](hub/overview.md#key-flows).

Changing the contract between peers: [changing the protocol](protocol.md#changing-the-protocol).

## Decisions

Every ADR, grouped by component, and the superseded ones: [ADR overview](../adr/overview.md). Each
component doc lists its own under Decisions.
