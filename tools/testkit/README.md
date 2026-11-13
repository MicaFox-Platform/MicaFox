# @micafox/testkit

The end-to-end test kit of the examples: it starts their apps and one fake hub as real child processes and waits on
what each prints. Private and never published; only `examples/*` depend on it, and ESLint keeps it out of
`packages/`. It is never built: it exports its TypeScript sources, which Vitest and tsx run as they are.

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
- `src/fake-hub/` — the fake hub, run as its own process: `main.ts` serves, and `startHub()` and node-basic's
  `dev:hub` run it by that path, `connection.ts` answers one app and prints
  what it sends, `breakpoints.ts` reads the breakpoints to set.

`readBreakpoints()` has unit tests in `src/fake-hub/__tests__/`; the rest of the kit is proven by the examples'
end-to-end tests, which run on it.

An example keeps only its own part of the harness in `tests/harness.ts`: how its apps start and where their
breakpoints go.

## Fake hub

It plays the hub side of [the protocol](../../docs/api/protocol.md#hello): it answers a `hello` with `welcome` and the
breakpoints to set, prints every message it receives as one JSON line, the messages of a batch one by one, and prints
`disconnected` once a connection closes, after its last message. It never prints headers or the token.

| Variable               | Meaning                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `PORT`                 | port, default `8787`; `0` picks a free one and prints it                         |
| `HUB_TOKEN`            | when set, an upgrade without `Authorization: Bearer <HUB_TOKEN>` gets 401        |
| `HUB_BREAKPOINTS`      | JSON array of breakpoints sent after `welcome`; wins over `HUB_BREAKPOINTS_FILE` |
| `HUB_BREAKPOINTS_FILE` | path of a file that holds that JSON array; neither set → no breakpoints          |

To try an app by hand, `pnpm --filter @micafox/node-basic dev:hub` starts it with node-basic's sample breakpoint:
[node-basic](../../examples/node-basic/README.md#run-it-locally).
