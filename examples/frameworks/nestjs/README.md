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

To try the app by hand, copy `.env.example` to `.env`, start [the kit's fake hub](../../../tools/testkit/README.md#fake-hub),
whose `.env.example` sets a breakpoint on the handler, and run the app on port 3002:

```sh
pnpm --filter @micafox/testkit start:hub
pnpm --filter @micafox/example-nestjs start
curl 'http://127.0.0.1:3002/quote?sku=SKU-2&quantity=3'
```

More in [the examples' README](../../README.md).

The tests run in `pnpm verify` through `pnpm test:build`, after `pnpm build`; `pnpm test` skips them, since they need
the build.
