# One image per example app, built from the repository root: `docker build -f sandbox/Dockerfile --target express .`
# The targets are the services of compose.yaml. NODE_IMAGE picks the base image: node:22-alpine, node:24-slim, ...
#
# Every app image holds one package deployed from the built workspace, at its path in the repository, so the hub's
# breakpoints (`sandbox/frameworks/express/src/quote.js`) still match the files by their path.
# The apps run as the non-root `node` user and are PID 1: no init process, no shell, no pnpm in front of them. Each
# one stops itself on SIGTERM.

ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm at the version of package.json's packageManager. Node 25+ ships no corepack and older ones an outdated one, so
# the build installs a pinned corepack from npm
RUN npm install -g corepack@0.36.0 && corepack enable pnpm
# A change under packages/ changes this layer, so a rebuild takes the new SDK
COPY . .
RUN --mount=type=cache,id=micafox-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm build
# Only what runs: the package, its production dependencies and the built workspace packages it uses
RUN --mount=type=cache,id=micafox-pnpm-store,target=/pnpm/store \
    set -e; \
    for deployment in \
        fastify=@micafox/example-fastify express=@micafox/example-express nestjs=@micafox/example-nestjs \
        nextjs=@micafox/example-nextjs formats=@micafox/example-formats testkit=@micafox/testkit; do \
      pnpm --filter "${deployment#*=}" --prod deploy --legacy --store-dir /pnpm/store "/out/${deployment%%=*}"; \
    done; \
    rm -rf /out/nextjs/src/.next/cache

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# The apps listen on every interface of the container; compose publishes their ports on the host's loopback only
ENV HOST=0.0.0.0
USER node

FROM runtime AS hub
COPY --from=build --chown=node:node /out/testkit /app/tools/testkit
WORKDIR /app/tools/testkit
CMD ["node", "--import", "tsx", "src/fake-hub/main.ts"]

FROM runtime AS fastify
COPY --from=build --chown=node:node /out/fastify /app/sandbox/frameworks/fastify
WORKDIR /app/sandbox/frameworks/fastify
CMD ["node", "dist/index.js"]

FROM runtime AS express
COPY --from=build --chown=node:node /out/express /app/sandbox/frameworks/express
WORKDIR /app/sandbox/frameworks/express
CMD ["node", "src/server.js"]

FROM runtime AS nestjs
COPY --from=build --chown=node:node /out/nestjs /app/sandbox/frameworks/nestjs
WORKDIR /app/sandbox/frameworks/nestjs
CMD ["node", "dist/main.js"]

FROM runtime AS nextjs
COPY --from=build --chown=node:node /out/nextjs /app/sandbox/frameworks/nextjs
WORKDIR /app/sandbox/frameworks/nextjs
# `next start` takes its address from the flag, not from HOST; its server writes to src/.next/cache, which `node` owns
CMD ["node", "node_modules/next/dist/bin/next", "start", "src", "--hostname", "0.0.0.0"]

FROM runtime AS formats
COPY --from=build --chown=node:node /out/formats /app/sandbox/formats
WORKDIR /app/sandbox/formats

FROM formats AS formats-cjs
CMD ["node", "src/cjs/server.js"]

FROM formats AS formats-esm
CMD ["node", "src/esm/server.js"]

FROM formats AS formats-tsc-cjs
CMD ["node", "dist/tsc-cjs/server.js"]

FROM formats AS formats-tsc-esm
CMD ["node", "dist/tsc-esm/server.js"]

FROM formats AS formats-bundled
CMD ["node", "dist/bundled/server.cjs"]
