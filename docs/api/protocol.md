# @probex-platform/protocol API

## Installation

```sh
pnpm add @probex-platform/protocol
```

Types and constants only, for `import` and `require()`. `@probex-platform/sdk` installs it for you; install it
yourself to write a custom connector or hub.

## Exports

### `Connector`

```ts
interface Connector {
  connect(): void;
  send(message: Message): void;
  onMessage(handler: (message: Message) => void): () => void;
  onStatus(handler: (status: ConnectorStatus) => void): () => void;
  close(): Promise<void>;
}
```

Carries protocol messages between the SDK and a hub. The SDK ships
[`HubConnector`](sdk/connector.md#hubconnector); implement this interface for any other transport. Why this shape:
[ADR 0004](../adr/0004-use-handler-functions-in-the-connector-interface.md).

Every implementation keeps this contract:

- `connect()` returns at once and connects in the background; a second call does nothing.
- `send(message)` returns at once; the connector may buffer, batch or, when full, drop messages.
- `onMessage(handler)` and `onStatus(handler)` return a function that removes the handler. A message reaching an
  `onMessage` handler has the session's `version` and a `type` the hub sends; its other fields are unchecked, so the
  handler checks them before it trusts them. A new status handler is not called with the current status, only with
  later changes.
- Handlers are never called synchronously from inside `connect()`, `send()` or `close()`, and a status is never
  reported twice in a row.
- `close()` resolves once the connector is closed; no handler is called after that. `closed` is reported once and
  is final: the SDK stops its debugger when a connector reports it. A second `close()` returns the same promise;
  `connect()` and `send()` after it do nothing.

**Errors** — no method throws and `close()` never rejects: the connector runs inside the host app. A handler that
throws must not stop the connector or the other handlers.

```ts
import type { Connector } from "@probex-platform/protocol";

function watch(connector: Connector): () => void {
  return connector.onStatus((status) => {
    console.info("connector:", status);
  });
}
```

### `ConnectorStatus`

```ts
type ConnectorStatus = "connecting" | "connected" | "disconnected" | "closed";
```

The state of a [`Connector`](#connector): `disconnected` before `connect()` and between reconnect attempts,
`connecting` until the hub accepts the session with [`welcome`](#welcome), `connected` after it, `closed` after
`close()`. Any status but `closed` may follow any other; `closed` follows only `close()` and nothing follows it.

```ts
import type { ConnectorStatus } from "@probex-platform/protocol";

const canSend = (status: ConnectorStatus): boolean => status === "connected";
```

### `PROTOCOL_VERSION`

```ts
const PROTOCOL_VERSION = 1;
```

The protocol version this package describes. Every message carries it in `version`; the message types below are
version 1 and fix `version` to `1`. Additions that old peers can ignore keep it; renaming, removing or retyping
anything a peer reads bumps it.

A session uses the version of its `hello`: `welcome` and every later message in both directions carry it, and a
message with another version is a protocol error. A hub accepts every version it still has types for and closes
with `incompatibleVersion` otherwise. The SDK speaks only its own `PROTOCOL_VERSION`. Why:
[ADR 0016](../adr/0016-use-the-hellos-protocol-version-for-the-session.md).

```ts
import { PROTOCOL_VERSION } from "@probex-platform/protocol";

const speaksSameVersion = (version: number): boolean => version === PROTOCOL_VERSION;
```

### `Message`

```ts
type Message = Hello | Welcome | Breakpoints | BreakpointStatus | Snapshot;
```

Every protocol message: one JSON object with a numeric `version` and a `type` string. A peer ignores a message
whose `type` it does not know, a message only the other side sends, and a repeated `hello`, on its own or inside a
[`Batch`](#batch). Anything that is not UTF-8 JSON text of an object with those two fields is not a protocol
message.

```ts
import type { Message } from "@probex-platform/protocol";

const isHello = (message: Message): boolean => message.type === "hello";
```

### `Hello`

```ts
interface Hello {
  version: 1;
  type: "hello";
  instanceId: string;
  service?: string;
  labels: Record<string, string>;
  hostname: string;
  pid: number;
  sdk: { name: string; version: string };
  runtime: { name: string; version: string };
}
```

The first message the SDK sends on every connection. `instanceId` is a random UUID that stays the same across
reconnects of one connector; `service` and `labels` are what the hub targets breakpoints by. Why the connector sends
it: [ADR 0009](../adr/0009-run-the-hub-handshake-in-the-connector.md).

Every connector and hub keeps this handshake:

1. The connector sends the token as `Authorization: Bearer <token>` on the WebSocket upgrade. The hub answers HTTP
   401 or 403 when it is missing or invalid. See [ADR 0006](../adr/0006-authenticate-to-the-hub-with-a-bearer-token.md).
2. The connector sends `hello` as the first frame and nothing else until it receives `welcome`.
3. The hub sends nothing before `welcome`, and replies `welcome` within 10 s of the `hello`, or closes with
   [`CLOSE_CODES`](#close_codes) `incompatibleVersion` or `protocolError`.
4. Right after `welcome`, the hub sends the full breakpoint state as a [`breakpoints`](#breakpoints) message, an
   empty list included.

On the wire:

- Every frame is a text frame holding one message or one [`Batch`](#batch).
- The SDK closes a connection with code 1009 when a frame from the hub is larger than 1 MiB. A hub accepts frames
  up to 1 MiB, or up to the SDK's `buffer.maxBytes` when it is set higher.
- The SDK sends a WebSocket ping every 15 s and drops a connection that sends nothing back within 10 s; a hub
  answers pings.

```ts
import { PROTOCOL_VERSION, type Hello } from "@probex-platform/protocol";

const hello: Hello = {
  version: PROTOCOL_VERSION,
  type: "hello",
  instanceId: crypto.randomUUID(),
  service: "checkout",
  labels: { region: "eu" },
  hostname: "checkout-7d9f",
  pid: 1,
  sdk: { name: "@probex-platform/sdk", version: "0.1.0" },
  runtime: { name: "node", version: process.versions.node },
};
```

### `Welcome`

```ts
interface Welcome {
  version: 1;
  type: "welcome";
}
```

The hub's reply to [`hello`](#hello): it accepts the session. A connector reports `connected` and starts sending
other messages only after it.

```ts
import { PROTOCOL_VERSION, type Welcome } from "@probex-platform/protocol";

const welcome: Welcome = { version: PROTOCOL_VERSION, type: "welcome" };
```

### `Batch`

```ts
interface Batch {
  version: 1;
  type: "batch";
  messages: Message[];
}
```

A frame from the SDK to the hub that carries one or more messages; the hub handles them in order, as if they came
one by one, and each keeps its own `version`. A hub accepts it alongside single messages; a connector may send
either. A batch never holds `hello` or another batch. Why:
[ADR 0005](../adr/0005-batch-and-rate-limit-messages-in-the-connector.md).

```ts
import { PROTOCOL_VERSION, type Batch, type Message } from "@probex-platform/protocol";

const toBatch = (messages: Message[]): Batch => ({ version: PROTOCOL_VERSION, type: "batch", messages });
```

### `Breakpoints`

```ts
interface Breakpoints {
  version: 1;
  type: "breakpoints";
  breakpoints: Breakpoint[];
}
```

From the hub: the complete list of [breakpoints](#breakpoint) the instance should have, sent right after
[`welcome`](#welcome) and on every change. The SDK sets the new ones, removes those missing from the list and sends
a [`breakpointStatus`](#breakpointstatus) for every listed breakpoint. An empty list removes all of them. Why a
full list: [ADR 0010](../adr/0010-send-the-full-breakpoint-set-on-every-change.md).

A hub sends at most 100 entries. In list order, entries after the 100th get status `error`; entries after the
200th, entries without a string `id`, and repeats of an `id` get no status.

```ts
import { PROTOCOL_VERSION, type Breakpoints } from "@probex-platform/protocol";

const breakpoints: Breakpoints = {
  version: PROTOCOL_VERSION,
  type: "breakpoints",
  breakpoints: [{ id: "bp-1", file: "src/orders/checkout.ts", line: 42 }],
};
```

### `Breakpoint`

```ts
interface Breakpoint {
  id: string;
  file: string;
  line: number;
  limits?: CaptureLimits;
}
```

One breakpoint in [`breakpoints`](#breakpoints).

- `id` — at most 256 characters, unique within the list; when an `id` appears again, the SDK uses the first entry
  and ignores the others. A later list with the same `id` and the same fields leaves the breakpoint as it is; a
  different `file`, `line` or `limits` replaces it. Breakpoints with different ids at the same place each get
  their own snapshots.
- `file` — the path as in the repository, separated by `/`, at most 1024 characters, such as
  `src/orders/checkout.ts`. The SDK matches it to the loaded file whose path ends with the most of its segments,
  through source maps for TypeScript.
- `line` — 1-based line in `file`. A line without code moves to the next line that has code.
- `limits` — [`CaptureLimits`](#capturelimits) for this breakpoint's snapshots.

```ts
import type { Breakpoint } from "@probex-platform/protocol";

const breakpoint: Breakpoint = { id: "bp-1", file: "src/orders/checkout.ts", line: 42, limits: { maxDepth: 2 } };
```

### `CaptureLimits`

```ts
interface CaptureLimits {
  maxDepth?: number;
  maxItems?: number;
  maxStringLength?: number;
}
```

How much of each value a snapshot keeps. Each limit is a positive integer; anything else gives the breakpoint
status `error`. The SDK lowers a larger value to its cap.

- `maxDepth` — levels of nested objects below a variable. Default `3`, at most `5`.
- `maxItems` — properties of an object, items of an array or set, entries of a map. Default `20`, at most `100`.
- `maxStringLength` — UTF-16 code units of a string, as `String.prototype.length` counts them. Default `256`, at
  most `4096`.

```ts
import type { CaptureLimits } from "@probex-platform/protocol";

const deep: CaptureLimits = { maxDepth: 5, maxItems: 50 };
```

### `BreakpointStatus`

```ts
interface BreakpointStatus {
  version: 1;
  type: "breakpointStatus";
  breakpointId: string;
  status: "pending" | "active" | "rateLimited" | "error";
  message?: string;
}
```

From the SDK: the state of one breakpoint, sent for every breakpoint of each [`breakpoints`](#breakpoints) message
and whenever it changes.

- `pending` — no loaded file matches `file` yet, or its source map is still being read; the breakpoint is set
  when one loads or the read ends.
- `active` — set; every hit captures a snapshot within the rate limit.
- `rateLimited` — it hit its own or the process's rate limit and is off until the limit refills, then `active`
  again.
- `error` — it cannot be set. `message` is always set for `error` and says why, for example: invalid fields, `file`
  matches several loaded files, no code at or after `line`, the source map cannot be read, or more than 100
  breakpoints.

```ts
import { PROTOCOL_VERSION, type BreakpointStatus } from "@probex-platform/protocol";

const status: BreakpointStatus = {
  version: PROTOCOL_VERSION,
  type: "breakpointStatus",
  breakpointId: "bp-1",
  status: "active",
};
```

### `Snapshot`

```ts
interface Snapshot {
  version: 1;
  type: "snapshot";
  breakpointId: string;
  time: number;
  stack: StackFrame[];
  variables: Variable[];
  truncated?: boolean;
}

interface StackFrame {
  function: string;
  file: string;
  line: number;
  column: number;
}

interface Variable {
  name: string;
  value: Value;
}
```

From the SDK: the state of the app at one hit of a breakpoint.

- `time` — milliseconds since the Unix epoch.
- `stack` — the call stack, innermost first, at most 20 frames. `file`, `line` and `column` are the original source
  position when the SDK has the file's source map loaded, which it does for files with breakpoints; otherwise the
  generated file's path or URL and position. `line` and `column` are 1-based.
- `variables` — of the innermost frame: `this`, then the local, block, catch, `with`, `eval`, closure and module
  scopes, innermost first; a name shadowed by an inner scope appears once. Global variables are not captured. A
  scope that cannot be read appears as one variable named after its type, such as `<closure scope>`, whose value is
  `unavailable`.
- `truncated` — `true` when the snapshot reached 64 KiB of JSON or 10 ms. The first value not read by then is
  `unavailable` with the reason, and the rest is left out: the remaining variables and properties, with `truncated`
  on their object, and the children of an `array`, `set` or `map`.

```ts
import type { Snapshot, Value } from "@probex-platform/protocol";

const total = (snapshot: Snapshot): Value | undefined =>
  snapshot.variables.find((variable) => variable.name === "total")?.value;
```

### `StackFrame`

```ts
interface StackFrame {
  function: string;
  file: string;
  line: number;
  column: number;
}
```

One frame of a [`Snapshot`](#snapshot)'s stack: the function's name, empty for an anonymous one, and its position as
described under `stack` there.

```ts
import type { StackFrame } from "@probex-platform/protocol";

const where = (frame: StackFrame): string => `${frame.file}:${String(frame.line)}`;
```

### `Variable`

```ts
interface Variable {
  name: string;
  value: Value;
}
```

A named [`Value`](#value): a variable of a [`Snapshot`](#snapshot) or a property of an `object` value.

```ts
import type { Variable } from "@probex-platform/protocol";

const names = (variables: Variable[]): string[] => variables.map((variable) => variable.name);
```

### `Value`

```ts
type Value =
  | { type: "undefined" }
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: number | "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { type: "bigint"; value: string }
  | { type: "symbol"; value: string }
  | { type: "string"; value: string; length: number }
  | { type: "function"; name: string }
  | { type: "date"; value: string }
  | { type: "error"; className: string; message: string; stack?: string }
  | { type: "object"; className: string; properties?: Variable[]; truncated?: boolean }
  | { type: "array"; length: number; items?: Value[] }
  | { type: "set"; size: number; items?: Value[] }
  | { type: "map"; size: number; entries?: Array<{ key: Value; value: Value }> }
  | { type: "accessor" }
  | { type: "circular" }
  | { type: "redacted" }
  | { type: "unavailable"; reason: string };
```

One captured value, with its children inline. Why a tree:
[ADR 0011](../adr/0011-encode-snapshot-values-as-a-nested-tree.md). What the [limits](#capturelimits) cut is
marked in place:

- a `string` keeps at most `maxStringLength` UTF-16 code units, never splitting a surrogate pair; `length` is the
  full length;
- an `array`, `set` or `map` with at most `maxItems` children keeps them all; a larger one keeps none, only its
  `length` or `size`, so a huge container is never read;
- an `object` keeps at most `maxItems` of its own enumerable properties and sets `truncated` when it has more;
- below `maxDepth`, `properties`, `items` and `entries` are left out; a missing one means not read, an empty one
  means empty;
- `accessor` stands for a getter, which is never run; `unavailable` for a value not read because of a limit or a
  failure, with the `reason`;
- `circular` stands for an object that contains itself. The SDK does not produce it, because V8 gives no object
  identity: an object that refers to itself is read again down to `maxDepth`. A reader still shows it;
- `redacted` stands for a value whose name matches the SDK's
  [redaction rules](sdk/debugger.md#debuggeroptions); its children were never read and its value is not sent.

A typed array or `Buffer` is an `array` of numbers. A `date` is an ISO 8601 string, to the whole second; an invalid
date is `unavailable`. A reader shows a `type` it does not know as `unavailable`.

```ts
import type { Value } from "@probex-platform/protocol";

const order: Value = {
  type: "object",
  className: "Order",
  properties: [{ name: "id", value: { type: "string", value: "o-17", length: 4 } }],
};
```

### `CLOSE_CODES`

```ts
const CLOSE_CODES = {
  protocolError: 4400,
  incompatibleVersion: 4426,
} as const;
```

WebSocket close codes either peer uses to end a session: `protocolError` when the first frame is not a valid
`hello` or `welcome`, a frame is not a protocol message, or a message has another version than the session;
`incompatibleVersion` when the hub does not speak the `hello`'s `version`. The SDK also closes a session the hub
has welcomed with 1000 when it closes, aborts one the hub has not welcomed yet without a close code, and closes with
1009 when a frame is too large, see [`Hello`](#hello).

```ts
import { CLOSE_CODES } from "@probex-platform/protocol";

const isRejected = (code: number): boolean => Object.values<number>(CLOSE_CODES).includes(code);
```

## Usage

A custom connector, here an in-memory one for tests, implements [`Connector`](#connector):

```ts
import type { Connector, ConnectorStatus, Message } from "@probex-platform/protocol";

type Handler<T> = (value: T) => void;

export class MemoryConnector implements Connector {
  readonly sent: Message[] = [];
  private readonly messageHandlers = new Set<Handler<Message>>();
  private readonly statusHandlers = new Set<Handler<ConnectorStatus>>();
  private status: ConnectorStatus = "disconnected";
  private closing: Promise<void> | undefined;

  connect(): void {
    if (this.status === "disconnected") {
      this.report("connecting");
      this.report("connected");
    }
  }

  send(message: Message): void {
    if (this.status !== "closed") {
      this.sent.push(message);
    }
  }

  onMessage(handler: Handler<Message>): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: Handler<ConnectorStatus>): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  receive(message: Message): void {
    queueMicrotask(() => {
      emit(this.messageHandlers, message);
    });
  }

  close(): Promise<void> {
    this.closing ??= new Promise((resolve) => {
      queueMicrotask(() => {
        this.status = "closed";
        emit(this.statusHandlers, "closed");
        this.messageHandlers.clear();
        this.statusHandlers.clear();
        resolve();
      });
    });
    return this.closing;
  }

  private report(status: ConnectorStatus): void {
    this.status = status;
    queueMicrotask(() => {
      emit(this.statusHandlers, status);
    });
  }
}

const emit = <T>(handlers: Set<Handler<T>>, value: T): void => {
  for (const handler of [...handlers]) {
    try {
      handler(value);
    } catch {
      // a failing handler must not stop the others
    }
  }
};
```
