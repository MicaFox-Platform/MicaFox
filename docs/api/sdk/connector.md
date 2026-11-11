# @micafox/sdk connector API

## Installation

Part of [`@micafox/sdk`](overview.md#installation).

## Exports

### `HubConnector`

```ts
class HubConnector implements Connector {
  constructor(options?: HubConnectorOptions);
  connect(): void;
  send(message: Message): void;
  onMessage(handler: (message: Message) => void): () => void;
  onStatus(handler: (status: ConnectorStatus) => void): () => void;
  close(): Promise<void>;
}
```

The default connector: carries protocol messages between the SDK and the hub over one WebSocket. The SDK creates
one from its own config, tuned through [`hubConnector`](debugger.md#debuggeroptions); create it yourself only to
use it without the debugger, such as in a tool or a test. It implements [`Connector`](../protocol.md#connector), so
a custom connector can replace it. It keeps the process alive only while `close()` sends what is left, for at most
1 s while a socket closes, for at most 10 s while a TCP connect to the hub is in progress, and while a DNS lookup
is in progress.
Design: [connector architecture](../../architecture/sdk/connector.md).

**Parameters**

Each option is resolved once, in the constructor: the passed value, then its environment variable, then the
default. An empty string counts as unset. A passed value that is invalid is ignored with a warning, and its
environment variable is not read. Only values that differ per deployment have an environment variable. See
[ADR 0003](../../adr/0003-configure-the-sdk-from-options-then-env.md). Every number option must be a finite
integer of at least 1, and `reconnect.minDelayMs` must not exceed `reconnect.maxDelayMs`.

- `options.url` — `string`, env `MICAFOX_HUB_URL`. The hub's WebSocket URL, `ws://` or `wss://`; userinfo and a
  fragment in it are not sent. No default.
  Certificates are always verified; add a custom CA with `NODE_EXTRA_CA_CERTS`. HTTP(S) proxies and redirects are
  not followed: the hub must be reachable directly.
- `options.token` — `string`, env `MICAFOX_TOKEN`. Sent as `Authorization: Bearer <token>` when connecting; never
  logged. With a token, `ws://` is allowed only to `localhost`, `127.0.0.0/8` and `[::1]`. No default. See
  [ADR 0006](../../adr/0006-authenticate-to-the-hub-with-a-bearer-token.md).
- `options.service` — `string`, env `MICAFOX_SERVICE`. The service name the hub targets breakpoints by. No default.
- `options.labels` — `Record<string, string>`, env `MICAFOX_LABELS` as `key=value` pairs separated by commas, such
  as `team=payments,region=eu`. Labels the hub can target breakpoints by. A passed object, even `{}`, replaces the
  env value; an entry whose value is not a string or whose key is empty is skipped with a warning, and one whose
  value is `undefined` is skipped silently. Env entries are
  trimmed and split at the first `=`, so `team=` keeps an empty value; an entry without `=` or with an empty key is
  skipped with a warning, an empty entry such as after a trailing comma is skipped silently, and a later key wins.
  Default: no labels.
- `options.logger` — [`Logger`](logger.md#logger). Default: `console`.
- `options.logLevel` — [`LogLevel`](logger.md#loglevel), env `MICAFOX_LOG_LEVEL`. Default `warn`.
- `options.buffer.maxMessages` — `number`, default `1000`. Data messages, such as snapshots, kept while they wait
  to be sent. Control messages, such as breakpoint status, wait in a separate
  queue of 200, at most 4 KiB each, that data never pushes out; it keeps only the latest status of each
  breakpoint.
- `options.buffer.maxBytes` — `number`, default `1048576` (1 MiB). Serialized size of the kept data messages. A
  larger single message is dropped.
- `options.batch.maxMessages` — `number`, default `100`. A batch is sent when it reaches any of the three batch
  limits.
- `options.batch.maxBytes` — `number`, default `65536` (64 KiB). UTF-8 size of one frame, `batch` envelope
  included. A larger single message is sent on its own.
- `options.batch.flushIntervalMs` — `number`, default `100`. The longest a message waits for its batch.
- `options.rateLimit.bytesPerSecond` — `number`, default `1048576` (1 MiB/s). Average outgoing rate, with bursts
  of up to one second's worth; messages wait in the buffer until the budget allows them.
- `options.reconnect.minDelayMs` — `number`, default `1000`. The first reconnect delay; it doubles after each
  failed attempt, with jitter, and goes back to this value once the hub accepts a session.
- `options.reconnect.maxDelayMs` — `number`, default `30000`. The longest reconnect delay.
- `options.closeTimeoutMs` — `number`, default `5000`. How long `close()` keeps sending buffered messages; it
  resolves at most 1 s later.

**Methods**

- `connect()` — starts connecting in the background and returns at once. On every connection it sends
  [`hello`](../protocol.md#hello) first; the status becomes `connected` once the hub replies
  [`welcome`](../protocol.md#welcome). Reconnects after every disconnect until `close()`. A second call does
  nothing.
- `send(message)` — serializes `message` and queues it, and returns; it goes to the hub later in a batch, control
  messages first, paced by the rate limit. A `hello` is dropped with a warning: the connector sends its own. When
  the data buffer is full, the oldest data messages are dropped and a warning is logged. Delivery is at most once:
  messages lost with a dropped connection are not resent. See
  [ADR 0007](../../adr/0007-deliver-messages-to-the-hub-at-most-once.md).
- `onMessage(handler)` — calls `handler` with every message from the hub after `welcome`, such as
  `breakpoints`. Handlers run in the order they subscribed. `welcome` itself and ignored frames (see Errors) never
  reach a handler, and nothing does once `close()` is called. Only `version` and `type` are checked: the message
  comes from the network, so a handler checks the other fields before it trusts them. Returns a function that
  removes it.
- `onStatus(handler)` — calls `handler` with the new [`ConnectorStatus`](../protocol.md#connectorstatus) on every
  change. Returns a function that removes it.
- `close()` — stops reconnecting and pinging. When connected, it sends buffered messages at once, in batches and
  within the rate limit, for up to `closeTimeoutMs`, keeping the process alive meanwhile, then drops the rest and
  closes the socket; otherwise it stops at once and sends nothing. Resolves within `closeTimeoutMs` + 1 s, after
  the status `closed`; a second call returns the same promise. Handlers are not called after it resolves.

Batching and rate limiting: see [ADR 0005](../../adr/0005-batch-and-rate-limit-messages-in-the-connector.md).

**Returns** — a connector with status `disconnected`; it does no I/O until `connect()`.

**Errors** — no method throws and `close()` never rejects, but every problem is logged to the
[`logger`](logger.md#logger): failures at `error`, problems the connector recovers from at `warn`. A problem
repeated within 60 s is logged once in full, then as one summary line with a count.

- No `url`, not a `ws://` / `wss://` URL, a `token` with `ws://` to a non-loopback host, or a `token` with
  characters an HTTP header cannot carry: `connect()` logs an error, connects nowhere, and the status stays
  `disconnected`.
- An invalid number option, `logger`, `logLevel`, `MICAFOX_LOG_LEVEL`, `labels` entry or `MICAFOX_LABELS` entry: a
  warning is logged and the default is used or the entry is skipped. `reconnect.minDelayMs` above
  `reconnect.maxDelayMs`: a warning, and both defaults are used.
- `options`, an option group such as `buffer`, or `labels` that is not an object: a warning, and the defaults are
  used. `url`, `token` or `service` that is not a string: a warning without the value, and the option stays unset.
- An option whose getter throws: a warning, and the option counts as unset.
- The hub is unreachable, the TLS handshake fails, the upgrade gets another HTTP status, the hub sends no
  `welcome` within 10 s, the connection drops or the hub stops answering pings: the status becomes
  `disconnected`, a warning is logged and the connector reconnects.
- The hub rejects the token (HTTP 401 or 403), sends a frame before `welcome` or a `welcome` of another protocol
  version, closes with `incompatibleVersion` or `protocolError`, or sends a frame over 1 MiB: an error is logged,
  the reconnect delay jumps to `reconnect.maxDelayMs`, and the connector keeps retrying.
- The hub sends a message of another protocol version after `welcome`: the connector closes the session with
  `protocolError`, logs an error, the reconnect delay jumps to `reconnect.maxDelayMs`, and it keeps retrying.
- A message that cannot be serialized, because `JSON.stringify` throws or returns no string, such as for
  `undefined`: an error is logged and the message is dropped.
- A control message dropped because 200 are waiting or because it is over 4 KiB, or a data message larger than
  `buffer.maxBytes`: a warning is logged.
- A binary frame, a frame that is not valid JSON, has no numeric `version` or no string `type`, or a message type
  only the SDK sends: a warning is logged and it is ignored. A message with an unknown `type` is logged at `debug`
  and ignored.
- A handler throws: the error is caught and logged; other handlers still run. The logger throws or rejects: the
  error is ignored.
- `close()` drops messages it could not send: one warning with their count.
- `connect()` or `send()` after `close()`: a warning is logged and nothing happens. `onMessage()` or `onStatus()`
  after `close()` returns a function that does nothing.

```ts
import { HubConnector } from "@micafox/sdk";

const connector = new HubConnector({
  url: "wss://hub.example.com/micafox",
  service: "checkout",
  labels: { region: "eu" },
});
connector.connect(); // token from MICAFOX_TOKEN
```

### `HubConnectorOptions`

```ts
interface HubConnectorOptions {
  url?: string;
  token?: string;
  service?: string;
  labels?: Record<string, string>;
  logger?: Logger;
  logLevel?: LogLevel;
  buffer?: { maxMessages?: number; maxBytes?: number };
  batch?: { maxMessages?: number; maxBytes?: number; flushIntervalMs?: number };
  rateLimit?: { bytesPerSecond?: number };
  reconnect?: { minDelayMs?: number; maxDelayMs?: number };
  closeTimeoutMs?: number;
}
```

The options of [`HubConnector`](#hubconnector); every field is optional and described there.

## Usage

In most apps the SDK creates the connector: set `MICAFOX_HUB_URL`, `MICAFOX_TOKEN` and `MICAFOX_SERVICE`, and nothing
else. To run one yourself:

```ts
import { PROTOCOL_VERSION } from "@micafox/protocol";
import { HubConnector } from "@micafox/sdk";

// url falls back to MICAFOX_HUB_URL
const connector = new HubConnector({ batch: { flushIntervalMs: 250 } });

connector.onStatus((status) => {
  console.info("micafox hub:", status);
});
connector.onMessage((message) => {
  console.info("from the hub:", message.type);
});

connector.connect();
// buffered until the hub accepts the session
connector.send({ version: PROTOCOL_VERSION, type: "breakpointStatus", breakpointId: "bp-1", status: "active" });

// the connector does not keep the process alive: your app's server or work does
process.once("SIGTERM", () => {
  void connector.close();
});
```
