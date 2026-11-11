# MicaFox API

## Packages

The SDK is a set of modules that share one connector to the hub. The debugger is its first module.

| Package             | Install it to                                            | API                     |
| ------------------- | -------------------------------------------------------- | ----------------------- |
| `@micafox/sdk`      | debug a Node.js app: the debugger and its hub connector  | [SDK](sdk/overview.md)  |
| `@micafox/protocol` | write a custom connector or hub: messages and interfaces | [protocol](protocol.md) |
| `@micafox/configs`  | share TypeScript, ESLint, Prettier and Vitest presets    | [configs](configs.md)   |

How the packages fit together: [architecture overview](../architecture/overview.md).

## Usage

- **Debug an app** — install `@micafox/sdk`, set `MICAFOX_HUB_URL`, `MICAFOX_TOKEN` and `MICAFOX_SERVICE`,
  and call `micafox.run()` at startup: [SDK usage](sdk/overview.md#usage).
- **Use another transport** — implement [`Connector`](protocol.md#connector) and pass it to the SDK as
  [`connector`](sdk/debugger.md#debuggeroptions).
- **Write a hub** — check the project key, answer [`hello`](protocol.md#hello) with a
  [`welcome`](protocol.md#welcome) that lists the modules you accept, send
  [`breakpoints`](protocol.md#breakpoints), and receive [`batch`](protocol.md#batch), [`snapshot`](protocol.md#snapshot)
  and [`breakpointStatus`](protocol.md#breakpointstatus) messages.

No MicaFox export throws into your app: problems are logged, an internal error turns MicaFox off and a lost hub
connection is retried. Protocol changes are
backward-compatible or bump [`PROTOCOL_VERSION`](protocol.md#protocol_version).
