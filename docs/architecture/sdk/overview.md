# SDK overview

## Components

```text
┌───────────────────────────────── @micafox/sdk ──────────────────────────────────┐
│ ┌───────── Debugger ─────────┐    send(message)    ┌────── HubConnector ──────┐ │  hello, messages (wss)   ┌─────┐
│ │ Breakpoints · SourceMaps   │────────────────────▶│ session · control queue  │─┼─────────────────────────▶│ Hub │
│ │ Pauses · RateLimiter       │◀────────────────────│ data buffer · batcher    │◀┼──────────────────────────│     │
│ │ Capture · InspectorSession │ onMessage, onStatus │ rate limit · reconnect   │ │  welcome, breakpoints    └─────┘
│ └───┬─────────┬─────────────┬┘                     └────────────┬─────────────┘ │
│     │         │             ▲                                   │               │
│     │         │ log lines   │                     ┌────────┐    │ log lines     │
│     │         └─────────────┼────────────────────▶│ Logger │◀───┘               │
│     │                       │                     └───┬────┘                    │
└─────┼───────────────────────┼─────────────────────────┼─────────────────────────┘
      │ Debugger.*, Runtime.* │ scriptParsed, paused    │ debug|info|warn|error(message, context)
      ▼                       │                         ▼
  ┌───────────────────────────┴─────┐               ┌───────────────────────┐
  │ V8 (node:inspector)             │               │ App logger or console │
  └─────────────────────────────────┘               └───────────────────────┘
```

- [Debugger](debugger.md) — the SDK's only module, the [`micafox`](../../api/sdk/debugger.md#micafox) object.
  Turns the hub's breakpoint list into V8 breakpoints through an in-process inspector session and captures
  snapshots within strict time, size and rate limits, with secrets redacted by name.
- [Connector](connector.md) — `HubConnector`, the default transport: the `hello` → `welcome` handshake, queues,
  batching, the rate limit and reconnects. A custom [`Connector`](../../api/protocol.md#connector) can replace it;
  the debugger sees only that interface.
- [Logger](logger.md) — the wrapper both write their problems through: the level filter, collapsing of repeats,
  holding lines during a pause, and safe calls into the app's [`Logger`](../../api/sdk/logger.md#logger).

`MICAFOX_ENABLED`, `MICAFOX_REDACT` and `MICAFOX_LOG_LEVEL` are settings of the whole SDK, not of the debugger
alone, even though the debugger resolves them today: [SDK API](../../api/sdk/overview.md#usage).

All three follow the same rules for the host app: no method throws, nothing waits on I/O, every timer and socket
is unref'd except the connector's `closeTimeoutMs` timer while it flushes on close (with the short holds in
[connector](connector.md#boundaries)), memory is bounded, and problems go to the configured
[`Logger`](../../api/sdk/logger.md#logger). The default `console` writes synchronously; see [logger](logger.md).

## Packages

`@micafox/sdk` depends on `@micafox/protocol` and `ws` only. The parts live in
`packages/sdk/src/debugger/`, `packages/sdk/src/connector/` and `packages/sdk/src/logger/`. Inside the SDK the
debugger imports the connector and the logger, the connector imports only the logger, and the logger imports no SDK
module, so the connector and the logger can move out together.

The package is built as ES modules (`dist/esm`) and as CommonJS (`dist/cjs`), and `exports` serves one to `import` and
the other to `require()`, see [ADR 0013](../../adr/0013-publish-the-packages-as-es-modules-and-commonjs.md). The
CommonJS build rejects top-level `await` and `import.meta`, so the sources use neither. Every copy, either build or
another install, shares [one debugger per process](debugger.md#boundaries).

## Key flows

- [Starting the debugger](debugger.md#starting)
- [Connecting to the hub](connector.md#connecting)
- [Applying breakpoints](debugger.md#applying-breakpoints)
- [Capturing a snapshot](debugger.md#capturing-a-snapshot)
- [Redacting secrets](debugger.md#redacting-secrets)
- [Sending a message](connector.md#sending-a-message)
- [Writing a log line](logger.md#writing-a-line) and
  [holding lines during a pause](logger.md#holding-lines-during-a-pause)
- [Losing the connection](debugger.md#losing-the-connection)
- [Stopping the debugger](debugger.md#stopping) and [closing the connector](connector.md#closing)

## Decisions

- [0001. Keep the protocol in its own package](../../adr/0001-keep-the-protocol-in-its-own-package.md)
- [0002. Ship the default connector inside the SDK](../../adr/0002-ship-the-default-connector-inside-the-sdk.md)
- [0003. Configure the SDK from options, then env](../../adr/0003-configure-the-sdk-from-options-then-env.md)
- [0008. Use WebSocket for the hub connection](../../adr/0008-use-websocket-for-the-hub-connection.md)
- [0013. Publish the packages as ES modules and CommonJS](../../adr/0013-publish-the-packages-as-es-modules-and-commonjs.md)
- [0017. Tag messages with their module and agree on modules](../../adr/0017-tag-messages-with-their-module-and-agree-on-modules.md)

Decisions of one component: [debugger](debugger.md#decisions), [connector](connector.md#decisions),
[logger](logger.md#decisions).
