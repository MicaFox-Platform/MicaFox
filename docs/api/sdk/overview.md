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
`connector`, `url`, `token`, `service` and `labels` are ignored.

| Variable            | Option     | Default                                                      |
| ------------------- | ---------- | ------------------------------------------------------------ |
| `MICAFOX_ENABLED`   | `enabled`  | `true`                                                       |
| `MICAFOX_HUB_URL`   | `url`      | none; required unless a `connector` is set                   |
| `MICAFOX_TOKEN`     | `token`    | none                                                         |
| `MICAFOX_SERVICE`   | `service`  | none                                                         |
| `MICAFOX_LABELS`    | `labels`   | no labels; format `team=payments,region=eu`                  |
| `MICAFOX_REDACT`    | `redact`   | built-in names only; format `iban,ssn`                       |
| `MICAFOX_LOG_LEVEL` | `logLevel` | `warn`; exactly `debug`, `info`, `warn`, `error` or `silent` |

Set them in the deployment, call `micafox.run()` as early as possible, and `micafox.stop()` in your app's shutdown:
[debugger usage](debugger.md#usage).
