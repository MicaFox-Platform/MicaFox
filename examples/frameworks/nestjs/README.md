# nestjs

The MicaFox SDK in a NestJS 12 app, started the way Nest expects and run from its built output, never from sources.
The app serves `GET /quote`, and its handler is the code to debug: a breakpoint on the line marked
`// breakpoint here` captures the request's values.

| Source | Runs                | Starts the SDK                              |
| ------ | ------------------- | ------------------------------------------- |
| `src/` | `node dist/main.js` | in `main.ts`, before `NestFactory.create()` |

## What NestJS needs

Set `"sourceMap": true` in the tsconfig the Nest CLI builds with, so breakpoints on `.ts` lines resolve. Call
`app.enableShutdownHooks()` and `await micafox.stop()` in `onApplicationShutdown()`. The example builds with
`@nestjs/cli` 11: `@nestjs/cli` 12 fails to start on Node.js 22.13, a bug of the CLI, not of NestJS.

## Layout

- `src/` — the Nest app, its `nest-cli.json` and its CommonJS `tsconfig.json`; built to `dist/`.
- `tests/` — the end-to-end tests and the description of the app, which they start with the fake hub of
  [`@micafox/testkit`](../../../tools/testkit/README.md) and one breakpoint.

## Run it

From the repository root, after `pnpm install`:

```sh
pnpm build                                       # the SDK, the protocol, then the Nest build
pnpm --filter @micafox/example-nestjs test:build # the end-to-end tests
```

To try the app by hand, start [the kit's fake hub](../../../tools/testkit/README.md#fake-hub) with a breakpoint on
the handler and run the app:

```sh
HUB_BREAKPOINTS='[{"id":"bp-1","file":"examples/frameworks/nestjs/src/quote.controller.ts","line":23}]' \
  pnpm --filter @micafox/example-fastify dev:hub
MICAFOX_HUB_URL=ws://127.0.0.1:8787/micafox PORT=3000 node examples/frameworks/nestjs/dist/main.js
curl 'http://127.0.0.1:3000/quote?sku=SKU-2&quantity=3'
```

The tests run in `pnpm verify` through `pnpm test:build`, after `pnpm build`; `pnpm test` skips them, since they need
the build.
