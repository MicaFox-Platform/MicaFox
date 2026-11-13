# Examples

Apps that load the built MicaFox SDK, each with a `.env.example` that sets a fixed port and a hub URL. Every app
connects to the one [fake hub](../tools/testkit/README.md#fake-hub), whose `.env.example` sets a breakpoint for each of
them. The tests never read a `.env`.

## Try an app by hand

From the repository root, after `pnpm install` and `pnpm build`. The scripts read `.env` with Node's
`--env-file-if-exists`, so they need Node 22.9 or later; without a `.env` an app starts with its defaults.

```sh
cp tools/testkit/.env.example tools/testkit/.env
cp examples/frameworks/fastify/.env.example examples/frameworks/fastify/.env
pnpm --filter @micafox/testkit start:hub       # terminal 1: the hub, on port 8787
pnpm --filter @micafox/example-fastify start   # terminal 2: the app
curl 'http://127.0.0.1:3000/price?sku=SKU-2&quantity=3'
```

The hub prints the `breakpointStatus` of the app's breakpoint and, after the request, its `snapshot`. Git ignores
`.env` and `.env.*`, so edit them freely; `Ctrl+C` stops a process.

## Apps

| App                | Port   | Command                                                | Request                                        |
| ------------------ | ------ | ------------------------------------------------------ | ---------------------------------------------- |
| Fastify            | `3000` | `pnpm --filter @micafox/example-fastify start`         | `curl 'http://127.0.0.1:3000/price?sku=SKU-2'` |
| Express            | `3001` | `pnpm --filter @micafox/example-express start`         | `curl 'http://127.0.0.1:3001/quote?sku=SKU-2'` |
| NestJS             | `3002` | `pnpm --filter @micafox/example-nestjs start`          | `curl 'http://127.0.0.1:3002/quote?sku=SKU-2'` |
| Next.js            | `3003` | `pnpm --filter @micafox/example-nextjs start`          | `curl 'http://127.0.0.1:3003/quote?sku=SKU-2'` |
| formats: CommonJS  | `3101` | `pnpm --filter @micafox/example-formats start:cjs`     | `curl 'http://127.0.0.1:3101/quote?sku=SKU-2'` |
| formats: ESM       | `3102` | `pnpm --filter @micafox/example-formats start:esm`     | `curl 'http://127.0.0.1:3102/quote?sku=SKU-2'` |
| formats: tsc → CJS | `3103` | `pnpm --filter @micafox/example-formats start:tsc-cjs` | `curl 'http://127.0.0.1:3103/quote?sku=SKU-2'` |
| formats: tsc → ESM | `3104` | `pnpm --filter @micafox/example-formats start:tsc-esm` | `curl 'http://127.0.0.1:3104/quote?sku=SKU-2'` |
| formats: bundled   | `3105` | `pnpm --filter @micafox/example-formats start:bundled` | `curl 'http://127.0.0.1:3105/quote?sku=SKU-2'` |

Fastify runs from its sources; the others run their built output, so `pnpm build` comes first. The five formats apps
share one `.env`, which has no `PORT`: each script has its own default, and
`PORT=4000 pnpm --filter @micafox/example-formats start:cjs` changes one. The breakpoints of the bundled and the
Next.js apps stay `pending`: bundled output is not supported
([compatibility](../docs/api/sdk/overview.md#compatibility)).

Node 22.9 to 23.x prints `.env not found. Continuing without it.` when there is no `.env`; the app starts anyway.
