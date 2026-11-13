# @micafox/testkit

The end-to-end test kit of the examples: it starts their apps and one fake hub as real child processes and waits on what
each prints. Private and never published; only the examples (`examples/*`, `examples/frameworks/*`) depend on it, and
ESLint keeps it out of `packages/`. It is never built: it exports its TypeScript sources, which Vitest and tsx run as
they are.

## Layout

- `src/index.ts` — the kit's exports.
- `src/child-process-run.ts` — `ChildProcessRun`: one process read line by line, without colour codes. Every wait
  ends on a line it prints, or fails at once with its output when it exits first; nothing sleeps.
- `src/processes.ts` — `startProcess()`, `createEnvironment()` and `useProcesses()`, which kills and awaits every
  process a test started, so none outlives it, and prints their output when the test fails.
- `src/hub.ts` — `startHub()`, `readStatus()` and `waitForStatus()`. The hub always runs from sources, with
  `--conditions=@micafox/source --import tsx`, so it never reads a stale build of the protocol.
- `src/markers.ts` — `findMarkerLine()`: the line a test sets its breakpoint on, found by a marker comment.
- `src/requests.ts` — `fetchInARow()`.
- `src/quote-app.ts` — what the framework examples share: a `QuoteApp` describes an app that serves `GET /quote`, and
  `startQuoteHub()`, `startQuoteApp()`, `fetchUntilCompleteSnapshot()` and `shutDownQuoteApp()` run it.
- `src/fake-hub/` — the fake hub, run as its own process: `main.ts` serves, and `startHub()` and the `start:hub` script
  run it by that path, `connection.ts` answers one app and prints what it sends, `modules.ts` picks the modules of its
  `welcome`, `breakpoints.ts` reads the breakpoints to set and counts their time left down.
- `test/` — `env-examples.test.ts`: the `.env.example` files and `start` scripts of the examples.
- `.env.example` — the hub's port and one breakpoint for each example app.

`readBreakpoints()`, `startCountdown()`, `acceptModules()` and how `onConnection()` answers a `hello` have unit tests in
`src/fake-hub/__tests__/`; the rest of the kit is proven by the examples' end-to-end tests, which run on it.

An example keeps only its own part of the harness in `tests/harness.ts`: how its apps start and where their
breakpoints go.

## Fake hub

It plays the hub side of [the protocol](../../docs/api/protocol.md#hello): it answers a `hello` with `welcome` and the
breakpoints to set (`welcome.modules` lists the `hello`'s modules the hub knows, which is `debugger`; a `hello` with
none of them gets an empty list and no breakpoints), prints every message it receives as one JSON line, the messages of
a batch one by one, and prints `disconnected` once a connection closes, after its last message. It never prints headers
or the token.

| Variable          | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `PORT`            | port, default `8787`; `0` picks a free one and prints it                  |
| `HUB_TOKEN`       | when set, an upgrade without `Authorization: Bearer <HUB_TOKEN>` gets 401 |
| `HUB_BREAKPOINTS` | JSON array of breakpoints sent after `welcome`; unset → no breakpoints    |

Each entry of `HUB_BREAKPOINTS` may set `expiresInMs`, the time the breakpoint lives, an integer of at least `0`; any
other value, or none, means 1 h (`3600000`). The hub fixes each deadline when it starts and counts it down: every
`breakpoints` message it sends carries the time left at that moment, never less than `0`, so an app that connects
later, or reconnects, gets a shorter time. Restart the hub to start the countdown again.

`pnpm --filter @micafox/testkit start:hub` runs it by hand and reads a `.env` in this folder, if there is one. Copy
`.env.example` to `.env` first: it sets `HUB_BREAKPOINTS` to one breakpoint for each example app, on the line marked
`// breakpoint here`, and `test/env-examples.test.ts` fails when one moves. The tests never read `.env`. How to run the
apps: [the examples' README](../../examples/README.md).
