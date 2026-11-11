# @micafox/sdk debugger API

## Installation

Part of [`@micafox/sdk`](overview.md#installation).

## Exports

### `micafox`

```ts
const micafox: Debugger;
```

The debugger, the SDK's first module. It sets non-breaking breakpoints and captures snapshots, and talks to the hub
through a connector. Modules added later get their own named exports and share the same
connector.
There is one per process, shared by every import of the SDK, even when two copies of the package are installed.
Call `configure()` if you need to, then `run()` once at startup, and `stop()` on shutdown. It keeps the process
alive only while `stop()` sends buffered snapshots.

Each breakpoint captures at most 10 snapshots per second and the process at most 50; past that, a breakpoint has
status `rateLimited` until its budget refills. Capturing stops after 10 ms per pause and at 64 KiB per snapshot;
a snapshot cut by either limit is `truncated`. An array, `Set` or `Map` with more children than `maxItems` is captured
with its size only. Details: [capturing a snapshot](../../architecture/sdk/debugger.md#capturing-a-snapshot).

The hub sets breakpoints by the file's path in your repository. For TypeScript, ship source maps: inline as a
`data:` URL or as `.map` files referenced by a relative URL; a map URL with a scheme, such as `file:` or `https:`,
and a map over 8 MiB are not read. Keep each compiled file's name, without its extension, the same as its
source's (`dist/checkout.js` for `src/checkout.ts`); bundled output is not supported. While breakpoints are set,
the debugger resumes every pause it did not cause, including `debugger` statements, so do not attach another
debugger to the process. When the process runs with `--inspect`, MicaFox does not start. A breakpoint on the
top-level code of a module with a source map can miss the module's first run, because the map is read after the
module loads. Design:
[debugger architecture](../../architecture/sdk/debugger.md).

**Methods**

- `configure(options?)` — sets [`DebuggerOptions`](#debuggeroptions) for the next `run()`. Each call merges its
  fields over the earlier ones: a field set by a later call replaces the earlier value whole, `labels` and
  `hubConnector` included. A field set to `undefined` is ignored, so a configured value, `connector` included,
  can be replaced but not removed. Optional: without it `run()` uses environment variables and defaults.
- `run()` — starts the debugger and returns at once: it resolves the options, opens an inspector session and
  connects to the hub in the background. Each option is resolved here, once: the value passed to `configure()`,
  then its environment variable, then the default (see
  [ADR 0003](../../adr/0003-configure-the-sdk-from-options-then-env.md)). Changes to `process.env` take
  effect on the next `run()`.
- `stop()` — removes all breakpoints, closes the inspector session and closes the connector the debugger created,
  which sends buffered snapshots for up to `hubConnector.closeTimeoutMs`. Resolves when done; `run()` may be called
  again after it, with the options configured so far.

Calls in any order are safe:

| Call          | Not running        | Running                         | Stopping                        |
| ------------- | ------------------ | ------------------------------- | ------------------------------- |
| `configure()` | merges the options | logs a warning, changes nothing | logs a warning, changes nothing |
| `run()`       | starts             | does nothing                    | logs a warning                  |
| `stop()`      | resolves at once   | stops                           | returns the same promise        |

**Errors** — a failure in the debugger only turns the debugger off; your app keeps running and serving as if
MicaFox were not there. No method throws, `stop()` never rejects, capturing stops after 10 ms per pause and 20 ms
per second, and every problem is logged to the [`logger`](#debuggeroptions). After a failed `run()` the debugger is not
running, so `configure()` and `run()` can be called again.

- No `url` and no `connector`: `run()` logs an error and the debugger does not start.
- The inspector is already open, by `--inspect` or `inspector.open()`: `run()` logs a warning and the debugger
  does not start.
- The inspector session cannot be opened or anything else fails while starting: an error is logged, whatever was
  started is stopped, and the debugger does not start.
- An unexpected error inside the debugger while it runs: it is logged and the debugger stops itself, as if
  `stop()` had been called.
- An invalid option value, `MICAFOX_ENABLED` or `MICAFOX_LOG_LEVEL`: a warning is logged and the default is used.
  A `redact` or `MICAFOX_REDACT` entry that is not a string, cannot be read or is empty after normalizing, such
  as the one after a trailing comma, is skipped with a warning, and names past the first 100 are ignored with one;
  the built-in names always apply.
- A custom `connector` reports `closed`: a warning is logged and the debugger stops itself.
- The logger throws or returns a rejected promise: the error is ignored; the debugger keeps working.

```ts
import { micafox } from "@micafox/sdk";

micafox.run(); // hub URL, token and service from MICAFOX_HUB_URL, MICAFOX_TOKEN and MICAFOX_SERVICE
```

### `Debugger`

```ts
interface Debugger {
  configure(options?: DebuggerOptions): void;
  run(): void;
  stop(): Promise<void>;
}
```

The type of [`micafox`](#micafox); its methods are described there.

```ts
import { micafox, type Debugger } from "@micafox/sdk";

const debuggerForTests: Debugger = micafox;
```

### `DebuggerOptions`

```ts
interface DebuggerOptions {
  enabled?: boolean;
  url?: string;
  token?: string;
  service?: string;
  labels?: Record<string, string>;
  redact?: string[];
  logger?: Logger;
  logLevel?: LogLevel;
  hubConnector?: Pick<HubConnectorOptions, "buffer" | "batch" | "rateLimit" | "reconnect" | "closeTimeoutMs">;
  connector?: Connector;
}
```

The options of [`micafox.configure()`](#micafox). Every field is optional.

**Parameters**

- `enabled` — `boolean`, env `MICAFOX_ENABLED` as `true` or `false`. When `false`, `run()` logs one info line and
  does nothing, so a deployment can switch MicaFox off without a code change. Default `true`.
- `url`, `token`, `service`, `labels` — passed to the default connector, with the same environment variables,
  defaults and rules as in [`HubConnector`](connector.md#hubconnector).
- `redact` — `string[]`, env `MICAFOX_REDACT` as names separated by commas, such as `iban,ssn,clientKey`. Names
  whose values are replaced with `redacted` in snapshots, added to the built-in ones (`password`, `secret`,
  `token`, `apikey`, `authorization`, `cookie`, `session` and more). Case, `_`, `-` and `.` are ignored, and a
  name matches every variable or property whose name contains it, at any depth. The built-in names cannot be
  removed. Names from the option and from `MICAFOX_REDACT` both apply, at most 100 together; a name is matched on its
  first 256 characters. Default: built-in names only. Rules:
  [redacting secrets](../../architecture/sdk/debugger.md#redacting-secrets),
  [ADR 0012](../../adr/0012-redact-secrets-by-name-inside-the-sdk.md).
- `logger` — [`Logger`](logger.md#logger), used by the debugger and by the default connector. Default: `console`.
- `logLevel` — [`LogLevel`](logger.md#loglevel), env `MICAFOX_LOG_LEVEL`: the lowest level written, for the debugger
  and the default connector. Default `warn`. A `configure()` call before `run()` applies `logger` and `logLevel`
  first, so its own warnings use them. A `HubConnector` you pass as `connector` uses its own `logger` and
  `logLevel`: pass them to its constructor too.
- `hubConnector` — tuning of the default connector: buffer, batch, rate limit, reconnect delays and close timeout,
  as in [`HubConnectorOptions`](connector.md#hubconnectoroptions).
- `connector` — a custom [`Connector`](../protocol.md#connector) used instead of `HubConnector`. `run()` calls its
  `connect()`; the debugger never closes it, so close it yourself after `stop()` resolves. When it is set, `url`,
  `token`, `service`, `labels` and `hubConnector` passed to `configure()` are ignored with a warning.

```ts
import { micafox } from "@micafox/sdk";

micafox.configure({
  service: "checkout",
  labels: { region: "eu" },
  redact: ["iban", "ssn"],
  hubConnector: { batch: { flushIntervalMs: 250 } },
});
```

## Usage

Set `MICAFOX_HUB_URL`, `MICAFOX_TOKEN` and `MICAFOX_SERVICE` in the deployment, start the debugger as early as
possible, and stop it as a step of your app's own shutdown:

```ts
import { createServer } from "node:http";
import pino from "pino";
import { micafox } from "@micafox/sdk"; // or: const { micafox } = require("@micafox/sdk");

micafox.configure({ logger: pino({ name: "micafox" }), labels: { region: "eu" } });
micafox.run();

const server = createServer((request, response) => response.end("ok")).listen(3000);

process.once("SIGTERM", () => {
  server.close(() => {
    // sends buffered snapshots; with the defaults it takes at most 6 s, then the process exits by itself
    void micafox.stop();
  });
});
```

`stop()` needs at most `hubConnector.closeTimeoutMs` + 1 s; leave that much in your orchestrator's grace period.
