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
`PORT=4000 pnpm --filter @micafox/example-formats start:cjs` changes one. The Next.js app's breakpoint turns `active`
once the route's chunk is loaded, on its first request at the latest
([compatibility](../docs/api/sdk/overview.md#compatibility)).

Node 22.9 to 23.x prints `.env not found. Continuing without it.` when there is no `.env`; the app starts anyway.

## Docker

Docker runs the same apps the way most Node apps run in production: one image per app, built from the workspace with
the built SDK, the app as the non-root `node` user and as PID 1, with no init process. It is optional: install
[Docker](https://docs.docker.com/get-docker/) with Compose v2, nothing else.

```sh
pnpm docker:up     # build every image and start the hub and the nine apps; Ctrl+C stops them
pnpm docker:down   # remove the containers and the network
pnpm test:docker   # the container tests: build, start their own stack, check every app, remove it
```

[`compose.yaml`](compose.yaml) starts the hub and every app on the ports above, published on `127.0.0.1` only, with the
settings of their `.env.example` files; only `MICAFOX_HUB_URL` changes, to `ws://hub:8787/micafox`. A `.env` is never
read. The hub's output, with each `breakpointStatus` and `snapshot`, is the output of `pnpm docker:up`; call an app with
the `curl` line from the table. `docker:up` always builds, so a change to `packages/sdk` or to an app is in the next
run.

[`Dockerfile`](Dockerfile) has one target per app; `NODE_IMAGE` picks the base image, `node:22-slim` by default:

```sh
NODE_IMAGE=node:22-alpine pnpm docker:up
docker build -f examples/Dockerfile --target express -t micafox-example-express .
```

Inside a container every app runs its built output, Fastify included, and listens on every interface: the images
set `HOST=0.0.0.0`, and the Next.js image passes `--hostname 0.0.0.0` itself. By hand the apps and the hub listen on
`HOST`, `127.0.0.1` when it is unset or empty; a shell that exports `HOST` as its machine name makes them listen there,
so unset it or set it in `.env`.
