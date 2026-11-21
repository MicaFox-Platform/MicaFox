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
features live in `ee/` under their own licence and reach the official image through one `#ee` import. Cloud and
self-hosted teams get that same image: a Cloud subscription or a `MICAFOX_LICENSE` key turns paid features on, and
without either every open feature works. The open "basic hub" without `ee/` is only a CI check that proves it.

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

The top folder tells a package's licence and how it ships
([ADR 0039](../adr/packages/0039-group-the-workspace-by-licence-and-delivery.md)): `packages/` holds the MIT building
blocks, `hub/` the AGPL-3.0-only open hub, which runs without `ee/`, `ee/` the proprietary paid extension, `sandbox/`
the apps that exercise the SDK, and `tools/` the private test kit. This is the one dependency matrix of the
repository; ESLint enforces it folder by folder, and `@micafox/configs` is a dev dependency of every package.

| Folder                      | Package                                        | Licence       | Ships as                                    | May import (`@micafox/*`)               |
| --------------------------- | ---------------------------------------------- | ------------- | ------------------------------------------- | --------------------------------------- |
| `packages/configs`          | `@micafox/configs`                             | MIT           | npm, dev-time only                          | -                                       |
| `packages/protocol`         | `@micafox/protocol`                            | MIT           | npm                                         | -                                       |
| `packages/sdk`              | `@micafox/sdk`                                 | MIT           | npm, runs in the host app                   | protocol                                |
| `packages/ui`               | `@micafox/ui`                                  | MIT           | private, in the hub image                   | -                                       |
| `hub/core`                  | `@micafox/hub-core`                            | AGPL-3.0-only | private, in the hub image                   | protocol, ui                            |
| `hub/<feature>`             | `@micafox/hub-<feature>`, first `hub-debugger` | AGPL-3.0-only | private, in the hub image                   | protocol, ui, hub-core                  |
| `hub/app`                   | `@micafox/hub`                                 | AGPL-3.0-only | the image, Compose and Helm; never imported | protocol, ui, hub-core, features; `#ee` |
| `ee/hub`                    | `@micafox/hub-ee`, not created yet             | `ee/LICENSE`  | private, in the hub image                   | protocol, ui, hub-core, features        |
| `tools/testkit`             | `@micafox/testkit`                             | MIT           | never published                             | protocol, hub through `./cli`           |
| `sandbox/formats`           | `@micafox/example-formats`                     | MIT           | never published                             | sdk, protocol, testkit                  |
| `sandbox/frameworks/<name>` | `@micafox/example-<name>`                      | MIT           | never published                             | sdk, testkit; `fastify` also protocol   |

- `packages/` never imports `hub/`, `ee/`, `tools/` or `sandbox/`.
- `hub/` takes only `protocol` and `ui` from `packages/`, never the SDK; hub features never import each other.
- `ee/` imports `packages/` and `hub/` as the table allows, never `hub/app`; only `hub/app` imports `ee/`, through
  `#ee` and `#ee/web` ([ADR 0023](../adr/hub/app/0023-build-the-open-core-and-ee-from-one-app-with-ee.md)).
- Only `tools/testkit` imports `hub/app`, through `@micafox/hub/cli`
  ([ADR 0038](../adr/packages/0038-let-the-test-kit-start-the-built-hub.md)), and only the sandbox apps import the
  test kit: product code never imports `tools/` or `sandbox/`.

What each part is:

- `@micafox/protocol` — messages, `PROTOCOL_VERSION` and the `Connector` interface; types and constants
  only. The SDK, custom connectors and hubs import it: [architecture](protocol.md), [API](../api/protocol.md).
- `@micafox/sdk` — the debugger, `HubConnector` and the logger, run in the host app. Depends on the protocol
  and `ws`: [architecture](sdk/overview.md), [API](../api/sdk/overview.md).
- `@micafox/configs` — shared TypeScript, ESLint, Prettier and Vitest presets; dev-time only, never in the
  host app: [architecture](configs.md), [API](../api/configs.md).
- The hub — `@micafox/ui`, `hub/` and `ee/hub`, private packages shipped only as the image
  `ghcr.io/micafox-platform/hub`: [architecture](hub/overview.md#packages), [API](../api/hub/overview.md).

A module of the platform is one slice through these folders: its SDK part in `packages/sdk/src/<module>`, its
messages in `@micafox/protocol`, its hub feature in `hub/<module>` with routes, screens and storage, and, when it has
paid parts, an extension of that feature in `ee/hub` behind an entitlement. The debugger is the first:
`packages/sdk/src/debugger`, the debugger messages and `hub/debugger`.

`sandbox/frameworks/fastify` is a demo app to try the SDK by hand: a Fastify server debugged by `micafox` under tsx,
with the kit's fake hub setting a sample breakpoint, and its end-to-end tests run both as real processes.
`sandbox/formats` runs the built SDK in one small app per format: plain JavaScript with `require()` and with `import`,
TypeScript compiled by tsc to CommonJS and to ES modules with `.map` files, and an esbuild bundle with one `.map`; its
tests run after the build. `sandbox/frameworks/express`, `nestjs` and `nextjs` run the built SDK in an Express app, a
NestJS app built by the Nest CLI and a Next.js app whose route handlers `next build` bundles, served by `next start`;
their tests run after the build too. All the sandbox apps start their processes and one fake hub through
`tools/testkit` (`@micafox/testkit`), which also holds `pnpm bench`, the benchmark of the SDK's overhead:
[README](../../tools/testkit/README.md). Once the hub is built, the kit starts it in
[test mode](hub/server.md#running-in-test-mode) from `@micafox/hub` in place of the fake hub; `pnpm bench` keeps the
fake hub, and `pnpm bench:hub` measures the hub with simulated instances.

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
