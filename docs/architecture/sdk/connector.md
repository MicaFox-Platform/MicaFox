# Connector

## Purpose

`HubConnector` is the SDK's default [`Connector`](../../api/protocol.md#connector): it carries protocol messages
between the [debugger](debugger.md) in the host app and the hub over one WebSocket. The SDK creates it from its own
config; developers create it themselves only to use it without the debugger, such as in a tool or a test. How to use
it: [API](../../api/sdk/connector.md).

## Boundaries

- Owns:
  - the WebSocket to the hub: TLS, the bearer token in the upgrade request, reconnects with backoff, liveness pings;
  - the session on each connection: the `hello` → `welcome` handshake and the protocol version check;
  - outgoing messages: serialization, the control queue and the data buffer, batching and the rate limit;
  - handing incoming messages and status changes to handlers;
  - deciding what it logs and at which level.
- Does not own:
  - message types, `PROTOCOL_VERSION` and close codes: the [protocol](../protocol.md);
  - what is sent and what an incoming message means, including re-applying breakpoints after a reconnect: the
    [debugger](debugger.md);
  - process signals and shutdown: the host app calls `close()`, directly or through the SDK;
  - filtering, collapsing and writing log lines: the [logger](logger.md).
- Constraints:
  - Never throws into the host app and `close()` never rejects. Every problem is logged through the
    [logger](logger.md): failures at `error`, problems the connector recovers from at `warn`.
  - Never blocks the event loop: `send()` only serializes the message once and queues it, building a log message
    only when its level is enabled. Batches are built and written from a timer or `setImmediate`, never inside
    `send()`; all I/O is asynchronous.
  - Never keeps the host process alive: the socket and every timer are unref'd, except the `closeTimeoutMs` timer
    while `close()` flushes, see [Closing](#closing). A DNS lookup or a TCP connect in progress cannot be unref'd and may hold a process that is
    otherwise done until it ends, a connect for at most 10 s. A closing socket holds it for at most 1 s while the
    hub answers the closing handshake.
  - Memory is bounded: the data buffer by `buffer.maxMessages` and `buffer.maxBytes`, the control queue by 200
    messages of at most 4 KiB each, incoming frames by 1 MiB.
  - Imports only `@probex-platform/protocol`, `ws`, the SDK [logger](logger.md) and Node built-ins. The logger
    imports no SDK module, so both can move to their own package.
  - TLS certificates are always verified; custom CAs come from `NODE_EXTRA_CA_CERTS`. Redirects are not followed.
  - The token is never logged and never sent over `ws://` to a host other than loopback: `localhost`, `127.0.0.0/8`
    or `[::1]`, matched by name without a DNS lookup. URLs are logged as origin and path only, never with userinfo or
    query; headers of the upgrade response and the hub's close reason are never logged. Userinfo in the URL is never
    sent.
  - WebSocket compression is off: it costs CPU and memory in the host app.
  - Connects to the hub directly; HTTP(S) proxies (`HTTPS_PROXY`) are not supported.
  - Delivery is at most once: a message lost with a dropped socket is not resent.

## Interactions

```text
              send(message)          ┌────────────────────────────┐   hello, messages, batches   ┌─────┐
┌──────────┐ ───────────────────────▶│        HubConnector        │─────────────────────────────▶│     │
│ Debugger │                         │                            │                              │ Hub │
└──────────┘ ◀───────────────────────│ session · queues · batcher │◀─────────────────────────────│     │
              onMessage, onStatus    │ rate limit · reconnect     │   welcome, messages, close   └─────┘
                                     └────────────────────────────┘
                                                   │
                                                   │ log lines
                                                   ▼
                                              ┌────────┐
                                              │ Logger │
                                              └────────┘
```

The debugger sees only the [`Connector`](../../api/protocol.md#connector) interface. On the wire every frame is one
JSON protocol message or a [`Batch`](../../api/protocol.md#batch) of them.

## Layout

```text
packages/sdk/src/connector/
├── index.ts                the connector's only entry: HubConnector, HubConnectorOptions
├── hub-connector/          the class the app sees: lifecycle, status, reconnects
│   ├── hub-connector.ts    HubConnector: connect, send, close, handlers; drives attempts and the batcher
│   ├── handlers.ts         the onMessage and onStatus handler lists; a throwing handler is logged
│   └── backoff.ts          reconnect delays with jitter
├── options/                what the app passes, resolved once
│   ├── options.ts          HubConnectorOptions, their defaults and environment variables
│   ├── config.ts           options plus the logger: the debugger's or the connector's own
│   ├── labels.ts           labels from the option or PROBEX_LABELS
│   └── read-field.ts       defensive reads of app objects and environment variables
├── connection/             one WebSocket to the hub
│   ├── attempt.ts          one connection: TLS, upgrade, handshake, frames, close
│   ├── attempt-failure.ts  why an attempt ended, without secrets
│   ├── hub-url.ts          checks the URL and the token before any connect
│   └── heartbeat.ts        liveness pings and the dead-connection timeout
├── session/                what is said on a connection: the handshake and the version check
│   ├── hello.ts            the hello sent first on every connection
│   ├── version.ts          the SDK version sent in hello
│   ├── welcome.ts          checks the first frame from the hub
│   └── inbound.ts          reads every later frame from the hub
└── outbound/               messages on their way to the hub
    ├── batcher.ts          serializes, queues and writes batches under the rate limit
    ├── queues.ts           the control queue and the data buffer with their bounds
    ├── fifo.ts             the queue both are built on
    └── token-bucket.ts     the rate limit
```

Each folder is entered through its `index.ts` and keeps its tests in its `__tests__/`. `hub-connector/` uses the
other four; `connection/` uses `session/`, which reads `Labels` from `options/`; `options/` and `outbound/` use no
other folder.

## Key flows

### Connecting

1. `connect()` checks the URL resolved in the constructor and returns. No URL, a URL that is not `ws://` or
   `wss://`, a token with `ws://` to a non-loopback host, or a token an HTTP header cannot carry: an error is logged,
   nothing is opened, and the status stays `disconnected`.
2. After `connect()` returns, the status becomes `connecting`. The connector opens the WebSocket with
   `Authorization: Bearer <token>` when a token is set, and unrefs the socket.
3. Once open, it sends [`hello`](../../api/protocol.md#hello) as the first frame: protocol version, service, labels,
   instance id, hostname, pid, SDK and Node versions.
4. The hub replies [`welcome`](../../api/protocol.md#welcome). The status becomes `connected` and the queued
   messages start to flow.
5. The hub sends the full breakpoint state; the debugger applies it. This happens after every connect, so nothing
   has to survive a disconnect.
6. On failure, or when a live connection drops, the status becomes `disconnected` and the next attempt waits the
   current delay. The delay starts at `reconnect.minDelayMs`, doubles after each failed attempt up to
   `reconnect.maxDelayMs`, and goes back to `reconnect.minDelayMs` after a `welcome`. Each wait is a random value
   between half and all of the current delay.
   - unreachable hub, TLS error, an HTTP status other than 101, 401 or 403 on the upgrade, or no `welcome` within
     10 s: a warning;
   - HTTP 401 or 403 on the upgrade, a frame before `welcome` or a `welcome` of another version, a message of another
     version after `welcome`, close code `incompatibleVersion` or `protocolError`, or an incoming frame over 1 MiB: an
     error, and the delay jumps to `reconnect.maxDelayMs`. The connector keeps trying, so it recovers when the token
     or the hub is fixed.

### Sending a message

1. `send(message)` serializes the message once. If `JSON.stringify` throws or returns no string, an error is logged
   and the message is dropped. A `hello` is dropped with a warning: the connector sends its own.
2. Data messages (snapshots) go to the data buffer. When it is full by `buffer.maxMessages` or `buffer.maxBytes`,
   the oldest data messages are dropped and a warning is logged. A single data message larger than
   `buffer.maxBytes` is dropped with a warning.
3. All other messages are control messages (breakpoint status, errors) and go to the control queue, so a burst of
   snapshots cannot hide a breakpoint's status from the hub. A queued `breakpointStatus` is replaced in its place by a
   newer one for the same `breakpointId`, so the queue holds at most one per breakpoint. Data never pushes control
   messages out; when 200 are waiting, the oldest is dropped and a warning is logged. A control message over 4 KiB is
   dropped with a warning. A new message type is control unless the connector lists it as data.
4. While `connected`, the batcher runs `batch.flushIntervalMs` after the first queued message, or at once from
   `setImmediate` when `batch.maxMessages` or `batch.maxBytes` are queued. It builds a batch only when the token
   bucket and the socket allow it, so messages wait in the queue and the buffer until then and a newer control
   message still goes first.
5. A batch takes control messages first, then data, up to `batch.maxMessages` and `batch.maxBytes`, which counts the
   frame's UTF-8 size with its `batch` envelope; a single message larger than `batch.maxBytes` goes on its own. It is
   written when the socket is open and has less than `batch.maxBytes` unsent, so a socket the hub is closing gets
   nothing and the messages wait for the next `welcome`. One message goes as itself, several as a `batch` frame.
6. The token bucket holds up to one second of `rateLimit.bytesPerSecond`. A frame larger than that waits for a full
   bucket and leaves it in debt, so a large snapshot is delayed, never stuck.
7. Messages already handed to the socket when it drops are lost; queued ones wait for the next `welcome`.

### Receiving a message

1. A frame larger than 1 MiB closes the connection with code 1009 and an error; the delay jumps to
   `reconnect.maxDelayMs` and the connector reconnects.
2. Before `welcome`, any other frame, or a `welcome` whose `version` is not `PROTOCOL_VERSION`, closes the socket
   with `protocolError`, logs an error and counts as a failed attempt: the delay jumps to `reconnect.maxDelayMs`.
   `welcome` is not passed to handlers; a later one is ignored at `debug`.
3. After `welcome`, a binary frame, a frame that is not valid JSON, has no numeric `version` or no string `type`, or
   a type the SDK sends (`hello`, `batch`, `breakpointStatus`, `snapshot`) is logged as a warning and ignored.
4. A message whose `version` is not `PROTOCOL_VERSION` closes the session with `protocolError` and an error, like a
   `welcome` of another version: a session speaks one version
   ([ADR 0016](../../adr/0016-use-the-hellos-protocol-version-for-the-session.md)).
5. A message with an unknown `type` is logged at `debug` and ignored, so older SDKs keep working with newer hubs.
   The connector module holds the list of types the hub sends.
6. Every other message goes to each `onMessage` handler, in the order they subscribed, checked for its `version`
   and `type` only: the [debugger](debugger.md) checks the other fields when it interprets the message. Handlers are
   called from a copy of the list, so one that unsubscribes or calls `close()` does not skip the others. A handler
   that throws is logged; the others still run. Status changes reach `onStatus` handlers the same way.

### Detecting a dead connection

1. While open, the connector sends a WebSocket ping every 15 s.
2. If nothing arrives from the hub within 10 s of a ping, neither a pong, a ping nor a message, it drops the socket
   with a warning and reconnects after the current delay, like after any dropped connection.

### Closing

1. `close()` stops reconnecting and pings. When `connected`, it refs a `closeTimeoutMs` timer, so the process stays
   alive while it sends queued messages at once, in batches and within the rate limit, for up to `closeTimeoutMs`.
   That timer is the only thing it refs. The flush ends early when nothing is left or the session ends; a session
   that ends first has its cause logged, and nothing reconnects. Messages from the hub are not delivered meanwhile. Otherwise the
   pending attempt or socket, including one the hub has not welcomed, is cancelled at once and nothing is sent.
2. It drops what is left, with one warning that says how many if there are any, closes the socket with code 1000,
   sets the status to `closed`, [flushes the logger](logger.md#flushing) and resolves.
3. The socket is terminated if the hub has not closed it within 1 s, so `close()` resolves within
   `closeTimeoutMs` + 1 s. A second call returns the same promise.
4. No handler is called after `close()` resolves; later `connect()` and `send()` calls log a warning and do nothing,
   and `onMessage()` and `onStatus()` return a function that does nothing.

## Decisions

- [0002. Ship the default connector inside the SDK](../../adr/0002-ship-the-default-connector-inside-the-sdk.md)
- [0003. Configure the SDK from options, then env](../../adr/0003-configure-the-sdk-from-options-then-env.md)
- [0004. Use handler functions in the Connector interface](../../adr/0004-use-handler-functions-in-the-connector-interface.md)
- [0005. Batch and rate-limit messages in the connector](../../adr/0005-batch-and-rate-limit-messages-in-the-connector.md)
- [0006. Authenticate to the hub with a bearer token](../../adr/0006-authenticate-to-the-hub-with-a-bearer-token.md)
- [0007. Deliver messages to the hub at most once](../../adr/0007-deliver-messages-to-the-hub-at-most-once.md)
- [0008. Use WebSocket for the hub connection](../../adr/0008-use-websocket-for-the-hub-connection.md)
- [0009. Run the hub handshake in the connector](../../adr/0009-run-the-hub-handshake-in-the-connector.md)
- [0016. Use the hello's protocol version for the session](../../adr/0016-use-the-hellos-protocol-version-for-the-session.md)
