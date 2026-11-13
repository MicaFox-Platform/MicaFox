# formats

The MicaFox SDK as real apps load it: one small `node:http` app per module format, each running the SDK's built
`dist/`, never its sources. Every app serves `GET /quote`, and `quote()` in its `quote.*` file is the code to debug:
a breakpoint on the line marked `// breakpoint here` captures the request's values.

| App            | Source         | Runs                      | Loads the SDK with                      |
| -------------- | -------------- | ------------------------- | --------------------------------------- |
| CommonJS       | `src/cjs/`     | `src/cjs/server.js`       | `require()` → `dist/cjs`                |
| ES modules     | `src/esm/`     | `src/esm/server.js`       | `import` → `dist/esm`                   |
| tsc → CommonJS | `src/tsc-cjs/` | `dist/tsc-cjs/server.js`  | `require()`, `.map` files beside the JS |
| tsc → ESM      | `src/tsc-esm/` | `dist/tsc-esm/server.js`  | `import`, `.map` files beside the JS    |
| bundled        | `src/bundled/` | `dist/bundled/server.cjs` | bundled in by esbuild, one `.map`       |

Bundled output is not supported ([debugger API](../../docs/api/sdk/debugger.md)): the bundled app runs and serves, but
its breakpoint stays `pending`. `tests/bundled.test.ts` records that, so a change shows up.

## Layout

- `src/<app>/` — the apps above. `src/cjs/` and `src/tsc-cjs/` hold a `package.json` with `"type": "commonjs"`;
  `src/tsc-cjs/` has its own `tsconfig.json`, as a CommonJS project needs, and `src/bundled/` one that only
  typechecks, since esbuild builds it.
- `tsconfig.json` — the ES module project: `src/tsc-esm/`.
- `tests/` — the end-to-end tests and their harness, which starts each app and the fake hub of
  [`@micafox/testkit`](../../tools/testkit/README.md) with one breakpoint.

## Run it

From the repository root, after `pnpm install`:

```sh
pnpm build                                       # the SDK, the protocol, then the tsc apps and the bundle
pnpm --filter @micafox/example-formats test:build # the end-to-end tests
```

To try an app by hand, start [the kit's fake hub](../../tools/testkit/README.md#fake-hub) with a breakpoint on
the app's `quote.*` and run the app with plain `node`:

```sh
HUB_BREAKPOINTS='[{"id":"bp-1","file":"examples/formats/src/tsc-esm/quote.ts","line":16}]' \
  pnpm --filter @micafox/example-fastify dev:hub
MICAFOX_HUB_URL=ws://127.0.0.1:8787/micafox PORT=3000 node examples/formats/dist/tsc-esm/server.js
curl 'http://127.0.0.1:3000/quote?sku=SKU-2&quantity=3'
```

The tests run in `pnpm verify` through `pnpm test:build`, after `pnpm build`; `pnpm test` skips them, since they need
the build.
