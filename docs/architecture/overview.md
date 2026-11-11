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

`examples/node-basic` is a demo app to try the SDK by hand: it runs `HubConnector` beside a Fastify server, with a
fake hub to connect to, and its end-to-end tests run both as real processes.

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

- [0001. Keep the protocol in its own package](../adr/0001-keep-the-protocol-in-its-own-package.md)
- [0002. Ship the default connector inside the SDK](../adr/0002-ship-the-default-connector-inside-the-sdk.md)
- [0003. Configure the SDK from options, then env](../adr/0003-configure-the-sdk-from-options-then-env.md)
- [0004. Use handler functions in the Connector interface](../adr/0004-use-handler-functions-in-the-connector-interface.md)
- [0005. Batch and rate-limit messages in the connector](../adr/0005-batch-and-rate-limit-messages-in-the-connector.md)
- [0006. Authenticate to the hub with a bearer token](../adr/0006-authenticate-to-the-hub-with-a-bearer-token.md)
- [0007. Deliver messages to the hub at most once](../adr/0007-deliver-messages-to-the-hub-at-most-once.md)
- [0008. Use WebSocket for the hub connection](../adr/0008-use-websocket-for-the-hub-connection.md)
- [0009. Run the hub handshake in the connector](../adr/0009-run-the-hub-handshake-in-the-connector.md)
- [0010. Send the full breakpoint set on every change](../adr/0010-send-the-full-breakpoint-set-on-every-change.md)
- [0011. Encode snapshot values as a nested tree](../adr/0011-encode-snapshot-values-as-a-nested-tree.md)
- [0012. Redact secrets by name inside the SDK](../adr/0012-redact-secrets-by-name-inside-the-sdk.md)
- [0013. Publish the packages as ES modules and CommonJS](../adr/0013-publish-the-packages-as-es-modules-and-commonjs.md)
- [0014. Pass SDK logs as a full message and a context](../adr/0014-pass-sdk-logs-as-a-full-message-and-a-context.md)
- [0015. Filter SDK logs by level before the app's logger](../adr/0015-filter-sdk-logs-by-level-before-the-apps-logger.md)
- [0016. Use the hello's protocol version for the session](../adr/0016-use-the-hellos-protocol-version-for-the-session.md)
- [0017. Tag messages with their module and agree on modules](../adr/0017-tag-messages-with-their-module-and-agree-on-modules.md)
- [0018. Expire breakpoints in the SDK by a time left from the hub](../adr/0018-expire-breakpoints-in-the-sdk-by-a-time-left-from-the-hub.md)
- [0019. Report the deployed commit in hello](../adr/0019-report-the-deployed-commit-in-hello.md)
