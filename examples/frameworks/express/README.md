# express

The MicaFox SDK in an Express 5 app, started the way Express expects and run from plain JavaScript. The app serves
`GET /quote`, and its handler is the code to debug: a breakpoint on the line marked `// breakpoint here` captures the
request's values.

| Source | Runs                 | Starts the SDK                                      |
| ------ | -------------------- | --------------------------------------------------- |
| `src/` | `node src/server.js` | on the first lines of `server.js`, with `require()` |

## What Express needs

Start MicaFox before the app loads its routes, and call `await micafox.stop()` on SIGTERM after the server has
closed. A handler's `request` and `response` come before its own variables and are large: on a slow machine, reading
them at the default depth can use up the 10 ms of a pause, and the variables after them are left out. Give a
breakpoint in a handler `limits: { maxDepth: 1 }` ([`CaptureLimits`](../../../docs/api/protocol.md)), as the tests
do.

## Layout

- `src/` — plain CommonJS JavaScript, with a `package.json` that says `"type": "commonjs"`.
- `tests/` — the end-to-end tests and the description of the app, which they start with the fake hub of
  [`@micafox/testkit`](../../../tools/testkit/README.md) and one breakpoint.

## Run it

From the repository root, after `pnpm install`:

```sh
pnpm build                                       # the SDK and the protocol
pnpm --filter @micafox/example-express test:build # the end-to-end tests
```

To try the app by hand, copy `.env.example` to `.env`, start [the kit's fake hub](../../../tools/testkit/README.md#fake-hub),
whose `.env.example` sets a breakpoint on the handler, and run the app on port 3001:

```sh
pnpm --filter @micafox/testkit start:hub
pnpm --filter @micafox/example-express start
curl 'http://127.0.0.1:3001/quote?sku=SKU-2&quantity=3'
```

More in [the examples' README](../../README.md).

The tests run in `pnpm verify` through `pnpm test:build`, after `pnpm build`; `pnpm test` skips them, since they need
the build.
