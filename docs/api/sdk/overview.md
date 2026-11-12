# @micafox/sdk API

## Installation

```sh
pnpm add @micafox/sdk
```

Node.js 22 or later, with `import` or `require()`. For TypeScript, ship source maps; bundles are not supported.
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

| Framework                                 | Tested with                                      | Breakpoints                         |
| ----------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| Fastify 5                                 | TypeScript run by tsx                            | yes                                 |
| Express 5                                 | CommonJS JavaScript run by `node`                | yes                                 |
| NestJS 12                                 | the Nest CLI's build: CommonJS with `.map` files | yes                                 |
| Next.js 16, Node.js runtime, `next start` | MicaFox started in `instrumentation.ts`          | not yet: route handlers are bundled |

Module formats are tested separately, in plain Node.js apps: CommonJS, ES modules, and TypeScript compiled by tsc with
source maps.

Not supported: bundled output (Next.js server code included), the Edge runtime, Vercel serverless functions, Bun and
Deno.

What each framework needs and the apps CI runs: [frameworks](../../../examples/frameworks/README.md),
[module formats](../../../examples/module-formats/README.md), [Fastify](../../../examples/node-basic/README.md).

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
