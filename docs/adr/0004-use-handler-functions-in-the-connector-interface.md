# 0004. Use handler functions in the Connector interface

## Status

Accepted · 2026-10-21

## Context

`Connector` lives in `@micafox/protocol`, which holds types and constants only and no Node-only APIs, and is
implemented by the default connector and by custom ones. The SDK and users subscribe to incoming messages and to
connection status. A connector runs inside the host app, so it must never throw into it or hold up its startup
while the hub is unreachable.

## Decision

We give `Connector` handler functions, `onMessage(handler)` and `onStatus(handler)`, that return an unsubscribe
function. `connect()` and `send()` return `void` and never throw, and `close()` returns a promise that never
rejects.

## Alternatives

- **Node's `EventEmitter`** (`on("message")`) — ties the interface to a Node-only API, event names are strings
  that are untyped by default, and an `"error"` event with no listener throws into the host app.
- **A callback in the constructor options** — the SDK receives a custom connector already constructed, so it could
  not attach its handlers, and a connector would have one listener only.
- **`connect(): Promise<void>` that settles on the first connection** — the host app's startup would wait for the
  hub or have to catch a rejection when it is down.

## Consequences

- The interface is small, works in any JavaScript runtime and is easy to fake in tests.
- A caller cannot await the first connection; it subscribes with `onStatus` before `connect()`, because a new
  handler gets only later changes.
- Every implementation catches errors from handlers, calls handlers only outside its own methods, never reports a
  status twice in a row and reports `closed` once, only after `close()`, as the
  [`Connector` contract](../api/protocol.md#connector) lists. The SDK stops its debugger when a connector reports
  `closed`.
