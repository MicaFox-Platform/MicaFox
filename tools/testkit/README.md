# @micafox/testkit

The end-to-end test kit and the benchmark of the examples: it starts their apps and one fake hub as real child
processes and waits on what each prints, and `pnpm bench` measures the SDK's overhead in the Fastify example. Its
`test/` also checks the scripts of `.github/scripts/`. Private
and never published; only the examples (`sandbox/*`, `sandbox/frameworks/*`) depend on it, and ESLint keeps it out
of `packages/`. It is never built: it exports its TypeScript sources, which Vitest and tsx run as
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
  `startQuoteHub()`, `startQuoteApp()`, `fetchUntilSnapshot()` and `shutDownQuoteApp()` run it.
- `src/fake-hub/` — the fake hub, run as its own process: `main.ts` serves, and `startHub()` and the `start:hub` script
  run it by that path, `connection.ts` answers one app and prints what it sends, `modules.ts` picks the modules of its
  `welcome`, `breakpoints.ts` reads the breakpoints to set and counts their time left down.
- `test/` — `env-examples.test.ts`: the `.env.example` files and `start` scripts of the examples; `docker.test.ts`:
  their Dockerfile and `compose.yaml` against those files, and the hub's `HOST`; `changesets.test.ts`: the changeset
  checks of `.github/scripts/check-changesets.sh`, in a throwaway git repository; `packs.test.ts`: the tarball checks
  of `.github/scripts/check-packs.sh` (`pnpm test:pack`), in a throwaway workspace; `licences.test.ts`: the licence
  checks of `.github/scripts/check-licences.sh`, against a stubbed `pnpm`; `structure.test.ts`: the folder checks of
  `.github/scripts/check-structure.sh`, in a throwaway git repository; `release-github.test.ts`: the tags
  and GitHub Releases of `.github/scripts/release-github.sh`, in a throwaway repository with stubbed `npm` and `gh`;
  `signatures.test.ts`: the commit signature checks of `.github/scripts/check-signatures.sh`, against a stubbed `gh`
  and in a throwaway repository with SSH-signed commits.
- `docker/` — the container tests of `pnpm test:docker`, run by `vitest.docker.config.ts` only, never by `pnpm test`:
  `compose.test.yaml` locks down every service of `sandbox/compose.yaml` (read-only root filesystem, a writable
  `/tmp`, 256 MB, SDK errors only) and reports it healthy once it serves; `stack.ts` starts, follows, stops and
  removes the stack with the docker CLI; `global-setup.ts` starts it once per run and always removes it; `apps.ts`
  describes each app; `__tests__/containers.test.ts` checks them.
- `bench/` — the [benchmark](#benchmark) of `pnpm bench`, never run by `pnpm test` or `pnpm verify`: `main.ts` runs the
  rounds and prints the result, `modes.ts` the four modes, `run.ts` one run of one mode, `load.ts` the load generator,
  `containers.ts` the docker CLI, `measure.ts` the pure part, unit-tested in `__tests__/`.
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

| Variable          | Meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `PORT`            | port, default `8787`; `0` picks a free one and prints it                    |
| `HOST`            | address it listens on, default `127.0.0.1`; the Docker image sets `0.0.0.0` |
| `HUB_TOKEN`       | when set, an upgrade without `Authorization: Bearer <HUB_TOKEN>` gets 401   |
| `HUB_BREAKPOINTS` | JSON array of breakpoints sent after `welcome`; unset → no breakpoints      |

Each entry of `HUB_BREAKPOINTS` may set `expiresInMs`, the time the breakpoint lives, an integer of at least `0`; any
other value, or none, means 1 h (`3600000`). The hub fixes each deadline when it starts and counts it down: every
`breakpoints` message it sends carries the time left at that moment, never less than `0`, so an app that connects
later, or reconnects, gets a shorter time. Restart the hub to start the countdown again.

An entry may also set `service`: the hub then sends it only to apps whose `hello` has that `service`, without the
field. Entries without it go to every app. The container tests use it, since the SDK matches a breakpoint's file by
the end of its path, so one app's `quote.js` breakpoint would also resolve in another app's `quote.js`.

`pnpm --filter @micafox/testkit start:hub` runs it by hand and reads a `.env` in this folder, if there is one. Copy
`.env.example` to `.env` first: it sets `HUB_BREAKPOINTS` to one breakpoint for each example app, on the line marked
`// breakpoint here`, and `test/env-examples.test.ts` fails when one moves. The tests never read `.env`. How to run the
apps: [the examples' README](../../sandbox/README.md).

## Benchmark

`pnpm bench` measures what the SDK costs the Fastify example and prints the table of
[the SDK's overhead](../../docs/api/sdk/overview.md#overhead) as Markdown; copy it into the doc by hand. It needs `docker`
on `PATH` with BuildKit and at least 7 vCPUs, and takes about 15 minutes.

- **Containers.** It builds the `fastify` and `hub` targets of `sandbox/Dockerfile` and runs each run on fresh
  containers on one network, with no published ports. The app gets `--cpus 1` pinned to vCPU 1 and
  `--memory 512m`, the fake hub vCPU 2, and the load generator, a container of the hub image, vCPUs 3 to 6. The app's
  output goes to `--log-driver none`: Fastify logs every request, and writing that through Docker would cost CPU outside
  the app's limits. The requests are still logged, as the example does.
- **Modes.** SDK off (`MICAFOX_ENABLED=false`: the SDK is loaded but does nothing, so its own memory is in every row);
  SDK on with no breakpoints; a breakpoint on a line no request runs (`src/values.ts`); a breakpoint on the line of
  `quote()` every request runs (`src/pricing.ts`), held to 10 snapshots a second by the rate limits. The lines come
  from their marker comments.
- **Load.** `GET /price` from 4 worker threads over keep-alive connections. Each run: 10 s of warm-up, 20 s closed
  loop over 32 connections for the most the app serves, then 20 s at a fixed 15,000 requests a second over 256
  connections for latency and CPU. That rate is below what the app serves in every mode, also on a slower core, and
  the connections are far more than the requests in flight, so none waits for a free one. At the fixed rate latency
  counts from when each request was due, so a slow app cannot hide its delay by slowing the load down. The generator
  sends on 1 ms timer ticks, so every latency holds up to about a tick of its own schedule: compare rows, not the
  absolute values with other tools. Requests per second and CPU per second count each thread's own send window, not
  its start-up.
- **Measures.** CPU is the app container's cgroup `cpu.stat` over the fixed-rate phase; memory is the peak resident
  set (`VmHWM`) of the app's PID 1; snapshots are counted in the fake hub's output.
- **Runs.** Three rounds, each mode once per round, in a rotated order so drift over the run does not always fall on
  one mode; every cell is the median with the range of the three runs. A difference inside that range is noise. The
  hot line is also compared with no breakpoints run by run within each round, which shares the host's state.
- **Checks.** A run fails instead of giving a number when the SDK does not connect to the hub (or connects while it
  is off); when its breakpoint is not `active` before the load, expires, or the app leaves the hub at any time in the
  run; when the cold line sends a snapshot or the hot line none; when a request fails or takes over 10 s; or when the
  load generator uses more than 80% of its vCPUs, so it, not the app, could be the limit. Every docker call has a
  timeout, so a stalled app fails the run instead of hanging it.
- **What it cannot show.** The pause time itself. The hot line's slowest request is an upper bound on one pause plus
  the app's own worst case, which alone reaches 15 to 50 ms here, so it cannot confirm the 10 ms per pause. Its CPU
  time per second minus that of no breakpoints is an estimate, not a bound, and it also holds what runs after each
  pause: cutting and sending the snapshot and setting the rate-limited breakpoint again. The run-to-run noise of CPU
  time is larger than the 20 ms a second budget, so the benchmark cannot resolve it.
