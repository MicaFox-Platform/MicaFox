# frameworks

The MicaFox SDK in the three most common Node.js frameworks, each started the way that framework expects and run
from its built output, never from sources. Every app serves `GET /quote`, and its handler is the code to debug: a
breakpoint on the line marked `// breakpoint here` captures the request's values.

| App                | Source         | Runs                         | Starts the SDK                                        |
| ------------------ | -------------- | ---------------------------- | ----------------------------------------------------- |
| Express 5          | `src/express/` | `node src/express/server.js` | on the first lines of `server.js`, with `require()`   |
| NestJS 12          | `src/nestjs/`  | `node dist/nestjs/main.js`   | in `main.ts`, before `NestFactory.create()`           |
| Next.js 16 (`app`) | `src/nextjs/`  | `next start src/nextjs`      | in `register()` of `instrumentation.ts`, Node.js only |

Breakpoints work in Express and NestJS. In Next.js the SDK runs, but a breakpoint in a route handler stays `pending`:
`next build` bundles route handlers, and bundled output is not supported ([SDK API](../../docs/api/sdk/overview.md#compatibility)).
`tests/nextjs.test.ts` records that, so a change shows up.

## What each framework needs

- **Express** — start MicaFox before the app loads its routes, and call `await micafox.stop()` on SIGTERM after the
  server has closed.
- **NestJS** — set `"sourceMap": true` in the tsconfig the Nest CLI builds with, so breakpoints on `.ts` lines
  resolve. Call `app.enableShutdownHooks()` and `await micafox.stop()` in `onApplicationShutdown()`. The example
  builds with `@nestjs/cli` 11: `@nestjs/cli` 12 fails to start on Node.js 22.13, a bug of the CLI, not of NestJS.
- **Next.js** — start MicaFox from `instrumentation.ts` only when `process.env.NEXT_RUNTIME === "nodejs"`, through a
  dynamic import, so the Edge bundle never contains the SDK. List `@micafox/sdk` in `serverExternalPackages` in
  `next.config.ts`, so Node.js loads it from `node_modules` instead of a bundle. `next start` shuts down gracefully on
  SIGTERM and exits by itself; call `micafox.stop()` from your own SIGTERM listener beside it, without exiting.

This example links the SDK from the workspace, and Turbopack bundles workspace packages even when they are listed in
`serverExternalPackages`, so `instrumentation-node.ts` imports the SDK with `/* turbopackIgnore: true */` instead.

## Layout

- `src/express/` — plain CommonJS JavaScript, with a `package.json` that says `"type": "commonjs"`.
- `src/nestjs/` — the Nest app, its `nest-cli.json` and its CommonJS `tsconfig.json`; built to `dist/nestjs/`.
- `src/nextjs/` — the Next.js project: `instrumentation.ts`, and `app/quote/` (Node.js runtime)
  and `app/edge/` (Edge runtime) route handlers; built to `src/nextjs/.next/`.
- `tests/` — the end-to-end tests, their harness and a fake hub that sets one breakpoint and prints every message it
  receives.

## Run it

From the repository root, after `pnpm install`:

```sh
pnpm build                                    # the SDK, the protocol, then the Nest and Next.js builds
pnpm --filter @micafox/frameworks test:build  # the end-to-end tests
```

To try an app by hand, start [node-basic's fake hub](../node-basic/README.md#run-it-locally) with a breakpoint on the
app's handler and run the app:

```sh
HUB_BREAKPOINTS='[{"id":"bp-1","file":"examples/frameworks/src/nestjs/quote.controller.ts","line":23}]' \
  pnpm --filter @micafox/node-basic dev:hub
MICAFOX_HUB_URL=ws://127.0.0.1:8787/micafox PORT=3000 node examples/frameworks/dist/nestjs/main.js
curl 'http://127.0.0.1:3000/quote?sku=SKU-2&quantity=3'
```

For Next.js, run `pnpm --filter @micafox/frameworks exec next start src/nextjs --port 3000` with `MICAFOX_HUB_URL`
set.

The tests run in `pnpm verify` through `pnpm test:build`, after `pnpm build`; `pnpm test` skips them, since they need
the build.
