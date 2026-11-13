# nextjs

The MicaFox SDK in a Next.js 16 app (`app` router), started the way Next.js expects and run from its built output,
never from sources. The app serves `GET /quote`, and its handler is the code to debug.

| Source | Runs             | Starts the SDK                                        |
| ------ | ---------------- | ----------------------------------------------------- |
| `src/` | `next start src` | in `register()` of `instrumentation.ts`, Node.js only |

In Next.js the SDK runs, but a breakpoint in a route handler stays `pending`: `next build` bundles route handlers,
and bundled output is not supported ([SDK API](../../../docs/api/sdk/overview.md#compatibility)).
`tests/nextjs.test.ts` records that, so a change shows up.

## What Next.js needs

Start MicaFox from `instrumentation.ts` only when `process.env.NEXT_RUNTIME === "nodejs"`, through a dynamic import,
so the Edge bundle never contains the SDK. List `@micafox/sdk` in `serverExternalPackages` in `next.config.ts`, so
Node.js loads it from `node_modules` instead of a bundle. `next start` shuts down gracefully on SIGTERM and exits by
itself; call `micafox.stop()` from your own SIGTERM listener beside it, without exiting.

This example links the SDK from the workspace, and Turbopack bundles workspace packages even when they are listed in
`serverExternalPackages`, so `instrumentation-node.ts` imports the SDK with `/* turbopackIgnore: true */` instead.

## Layout

- `src/` — the Next.js project: `instrumentation.ts`, and `app/quote/` (Node.js runtime) and `app/edge/` (Edge
  runtime) route handlers; built to `src/.next/`.
- `tests/` — the end-to-end tests and the description of the app, which they start with the fake hub of
  [`@micafox/testkit`](../../../tools/testkit/README.md) and one breakpoint.

## Run it

From the repository root, after `pnpm install`:

```sh
pnpm build                                       # the SDK, the protocol, then the Next.js build
pnpm --filter @micafox/example-nextjs test:build # the end-to-end tests
```

To try the app by hand, start [the kit's fake hub](../../../tools/testkit/README.md#fake-hub), run the app with
`MICAFOX_HUB_URL` set, and send a request:

```sh
pnpm --filter @micafox/example-fastify dev:hub
MICAFOX_HUB_URL=ws://127.0.0.1:8787/micafox pnpm --filter @micafox/example-nextjs exec next start src --port 3000
curl 'http://127.0.0.1:3000/quote?sku=SKU-2&quantity=3'
```

The tests run in `pnpm verify` through `pnpm test:build`, after `pnpm build`; `pnpm test` skips them, since they need
the build.
