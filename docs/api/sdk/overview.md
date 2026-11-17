# @micafox/sdk API

## Installation

```sh
pnpm add @micafox/sdk
```

Node.js 22 or later, with `import` or `require()`. For TypeScript and bundles, ship source maps.
What else the app needs: [`micafox`](debugger.md#micafox).

What your app can rely on:

- There is one [`micafox`](debugger.md#micafox) per process, shared by every copy of the SDK.
- No method throws; an internal error turns MicaFox off and the app keeps running. Capturing stops after 10 ms per
  pause and 20 ms per second; a snapshot is at most 64 KiB.
- MicaFox keeps the process alive only while `stop()` sends buffered snapshots, for up to 6 s by default, and
  briefly while it connects to the hub or closes a connection: [`HubConnector`](connector.md#hubconnector).
- Its problems go to `console` at `warn` and above, or to your [`Logger`](logger.md#logger).

### Compatibility

CI runs each framework below in a real app on Node.js 22.13 and 24, with breakpoints set by a hub:

| Framework                                 | Tested with                                      | Breakpoints                                  |
| ----------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Fastify 5                                 | TypeScript run by tsx                            | yes                                          |
| Express 5                                 | CommonJS JavaScript run by `node`                | yes                                          |
| NestJS 12                                 | the Nest CLI's build: CommonJS with `.map` files | yes                                          |
| Next.js 16, Node.js runtime, `next start` | MicaFox started in `instrumentation.ts`          | yes, in route handlers after their first use |

Module formats are tested separately, in plain Node.js apps: CommonJS, ES modules, TypeScript compiled by tsc with
source maps, and TypeScript bundled by esbuild with a source map.

Not supported: bundles without source maps, the Edge runtime, Vercel serverless functions, Bun and Deno.

What each framework needs and the apps CI runs: [Express](../../../examples/frameworks/express/README.md),
[NestJS](../../../examples/frameworks/nestjs/README.md), [Next.js](../../../examples/frameworks/nextjs/README.md),
[Fastify](../../../examples/frameworks/fastify/README.md), [module formats](../../../examples/formats/README.md).

### Overhead

What MicaFox cost the [Fastify example](../../../examples/frameworks/fastify/README.md) serving `GET /price`, measured
by `pnpm bench` on 2026-11-14. The app ran in its Docker image with `--cpus 1` pinned to one vCPU and `--memory 512m`,
on Node.js 22.23.5, under OrbStack (11 vCPUs, 8.8 GiB) on an Apple M3 Pro. Max req/s is the most the app served; the
other columns are at a fixed 15,000 requests a second. Each cell is the median of 3 runs, with their range. Method and
what it cannot show: [the benchmark](../../../tools/testkit/README.md#benchmark).

| Mode                                  | Max req/s              | p50 ms           | p99 ms               | Max ms            | CPU ms/s      | RSS MiB       | Snapshots/s      |
| ------------------------------------- | ---------------------- | ---------------- | -------------------- | ----------------- | ------------- | ------------- | ---------------- |
| SDK off (`MICAFOX_ENABLED=false`)     | 49,227 (49,186–49,433) | 2.32 (2.31–2.53) | 6.69 (6.69–7.46)     | 21.2 (20.5–32.6)  | 464 (459–471) | 99 (93–99)    | 0.0 (0.0–0.0)    |
| SDK on, no breakpoints                | 47,149 (47,138–48,370) | 2.53 (2.29–2.53) | 7.27 (6.69–7.37)     | 26.0 (25.7–31.1)  | 470 (468–475) | 93 (92–101)   | 0.0 (0.0–0.0)    |
| 1 breakpoint, cold line               | 47,685 (46,071–49,329) | 2.35 (2.31–2.54) | 6.66 (6.66–7.55)     | 27.7 (22.1–34.3)  | 473 (465–476) | 101 (100–108) | 0.0 (0.0–0.0)    |
| 1 breakpoint, hot line (rate-limited) | 46,579 (42,621–47,058) | 2.52 (2.37–2.56) | 13.31 (13.22–405.80) | 35.7 (35.3–591.4) | 484 (479–527) | 108 (102–109) | 10.0 (10.0–10.0) |

- With MicaFox on, with no breakpoints or a breakpoint on a line no request runs, the app served about 3% fewer
  requests at most (47,000 to 48,000 a second against 49,000 with it off). At the fixed rate, latency, CPU time and
  memory stayed within the range of the runs.
- A breakpoint on a line every request runs captured 10 snapshots a second, its rate limit, and cost about 5% of the
  most requests served. At the fixed rate the requests that hit a pause waited: p99 rose by about 6 ms. In one run of
  three, requests stalled for up to 0.6 s.
- The [pause limits](debugger.md#micafox) are not confirmed from outside. The hot line's slowest request, 35 ms, also
  holds the app's own worst case, which reached 21 to 34 ms without a breakpoint. Compared run by run, the hot line
  added 9.4 ms of CPU time a second in two runs of three, but the runs vary more than the 20 ms a second budget.

## Exports

- [Debugger](debugger.md):
  - [`micafox`](debugger.md#micafox) — the debugger: `configure()`, `run()`, `stop()`.
  - [`Debugger`](debugger.md#debugger) — the type of `micafox`.
  - [`DebuggerOptions`](debugger.md#debuggeroptions) — the options of `configure()`.
- [Connector](connector.md):
  - [`HubConnector`](connector.md#hubconnector) — the default transport to the hub. The SDK creates it and you tune
    it through `hubConnector`; create one yourself only to use it without the debugger.
  - [`HubConnectorOptions`](connector.md#hubconnectoroptions) — its options.
- [Logger](logger.md):
  - [`Logger`](logger.md#logger) — where the SDK writes its own problems; `console`, pino and winston fit.
  - [`LogContext`](logger.md#logcontext) — the structured fields of each line.
  - [`LogLevel`](logger.md#loglevel) — the lowest level written.

Protocol types, such as [`Connector`](../protocol.md#connector), come from
[`@micafox/protocol`](../protocol.md).

## Usage

`MICAFOX_ENABLED`, `MICAFOX_REDACT` and `MICAFOX_LOG_LEVEL` are settings of the whole SDK, not of the debugger
alone. Each option is resolved once, at `micafox.run()`: the value passed to `configure()`, then the environment
variable, then the default. A `HubConnector` you create resolves its own in its constructor. With a custom
`connector`, `url`, `token`, `service`, `commit` and `labels` are ignored.

| Variable            | Option     | Default                                                      |
| ------------------- | ---------- | ------------------------------------------------------------ |
| `MICAFOX_ENABLED`   | `enabled`  | `true`                                                       |
| `MICAFOX_HUB_URL`   | `url`      | none; required unless a `connector` is set                   |
| `MICAFOX_TOKEN`     | `token`    | none                                                         |
| `MICAFOX_SERVICE`   | `service`  | none                                                         |
| `MICAFOX_COMMIT`    | `commit`   | none; a commit hash of 7 to 64 hexadecimal characters        |
| `MICAFOX_LABELS`    | `labels`   | no labels; format `team=payments,region=eu`                  |
| `MICAFOX_REDACT`    | `redact`   | built-in names only; format `iban,ssn`                       |
| `MICAFOX_LOG_LEVEL` | `logLevel` | `warn`; exactly `debug`, `info`, `warn`, `error` or `silent` |

Set them in the deployment, call `micafox.run()` as early as possible, and `micafox.stop()` in your app's shutdown:
[debugger usage](debugger.md#usage).
