# node-basic

A demo app for the MicaFox SDK: a Fastify server debugged by `micafox`, configured by the `MICAFOX_*` environment
variables. `GET /price` calls `quote()` in `src/pricing.ts`, the code to debug; its local `apiKey` shows how a
snapshot redacts secrets.

`src/values.ts` adds one route per group of value types, each holding its values as locals to capture:
`/values/primitives`, `nesting`, `collections`, `objects`, `large` and `secrets`. A breakpoint on the line after
`// breakpoint on the next line: <group>` shows how a snapshot encodes each kind of value and where its limits cut it.

The fake hub of [`@micafox/testkit`](../../tools/testkit/README.md#fake-hub) plays the hub: it sets breakpoints and
prints what the app sends back. `pnpm dev:hub` starts it with the sample breakpoint of
`src/hub/sample-breakpoints.json`.

## Run it locally

From the repository root, after `pnpm install`, start the fake hub in one terminal:

```sh
pnpm --filter @micafox/node-basic dev:hub
# listening on port 8787
```

Then the app in another:

```sh
MICAFOX_HUB_URL=ws://127.0.0.1:8787/micafox MICAFOX_SERVICE=demo MICAFOX_LOG_LEVEL=info \
  pnpm --filter @micafox/node-basic dev
```

The app logs JSON lines through Fastify's pino, the SDK's `[micafox]` lines among them. The hub prints every message
it receives as one JSON line: the `hello`, then a `breakpointStatus` for its sample breakpoint on the return of
`quote()`, `active` once set. Hit the breakpoint and watch the snapshot arrive, with the local variables and `apiKey`
as `redacted`:

```sh
curl 'http://127.0.0.1:3000/price?sku=SKU-2&quantity=3'
```

The request is answered as usual: the breakpoint never stops the app. Stop the hub and the app keeps serving; start
it again and the app reconnects within a second and reports the breakpoint again. `Ctrl+C` stops the app: it sends
the buffered snapshots, then exits.

## Configuration

App:

| Variable            | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `PORT`              | HTTP port, default `3000`; `0` picks a free one                               |
| `MICAFOX_HUB_URL`   | the hub's WebSocket URL; unset → the SDK logs an error and the app runs on    |
| `MICAFOX_TOKEN`     | sent as `Authorization: Bearer <token>`                                       |
| `MICAFOX_SERVICE`   | service name in the `hello`                                                   |
| `MICAFOX_LABELS`    | labels in the `hello`, such as `team=payments,region=eu`                      |
| `MICAFOX_LOG_LEVEL` | the lowest level of the SDK's lines, default `warn`; `info` shows its startup |
| `MICAFOX_ENABLED`   | `false` turns MicaFox off: no connection, the app serves as usual             |
| `PRICING_API_KEY`   | the secret `quote()` signs with; a demo value by default                      |
| `VALUES_SECRET`     | the secret `/values/secrets` nests in its values; a demo value by default     |

All `MICAFOX_*` variables: [SDK API](../../docs/api/sdk/debugger.md#debuggeroptions). The app always uses a reconnect
delay of 100 ms to 1 s, a demo choice that lets a restarted hub see it again quickly.

Fake hub: `PORT`, `HUB_TOKEN` and `HUB_BREAKPOINTS`, which replaces the sample breakpoint on the return of `quote()`:
[its variables](../../tools/testkit/README.md#fake-hub).

A breakpoint names its file by the path in the repository, such as
`[{"id":"bp-1","file":"examples/node-basic/src/a/util.ts","line":5}]`. `src/a/util.ts` and `src/b/util.ts` share a
name on purpose: a breakpoint on `util.ts` alone gets status `error`, and one on a file the app has not loaded
`pending`.

## Tests

`tests/` starts the kit's fake hub and the app as real processes under tsx and checks the debugger end to end: a
breakpoint in `pricing.ts` and its snapshot, redaction, `pending` and `error` statuses, serving under load, a hub
restart, a rejected token, startup options and shutdown, and a snapshot of every group of value types of
`src/values.ts`: encodings, limits, truncation and redaction at any depth. They run in `pnpm verify`, or alone with
`pnpm --filter @micafox/node-basic test`.
