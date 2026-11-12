# @micafox/configs

Shared tooling configs for MicaFox and other TS/Node projects.

| Export                                         | Tool       | Usage                                                                                       |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `@micafox/configs/tsconfig/base.json`          | TypeScript | `"extends": "@micafox/configs/tsconfig/base.json"`                                          |
| `@micafox/configs/tsconfig/workspace.json`     | TypeScript | a monorepo package: `src/` → `dist/`, composite, tests and type tests left out of the build |
| `@micafox/configs/tsconfig/workspace-cjs.json` | TypeScript | the CommonJS build of such a package: `src/` → `dist/cjs/`                                  |
| `@micafox/configs/eslint`                      | ESLint     | `export default [...config, { /* overrides */ }]`                                           |
| `@micafox/configs/prettier`                    | Prettier   | `export { default } from "@micafox/configs/prettier"`                                       |
| `@micafox/configs/vitest`                      | Vitest     | `export default createVitestConfig()`, `mergeConfig` it for overrides                       |

ESLint plugins are bundled as dependencies. `eslint`, `prettier`, `typescript` and `vitest` are optional peer
dependencies — install only the tools you use.

To run tests against workspace sources without a build, export a source condition from each package, for example
`"@acme/source": "./src/index.ts"`, and build the Vitest config with it:

```ts
import { createVitestConfig } from "@micafox/configs/vitest";

export default createVitestConfig({ sourceCondition: "@acme/source" });
```

Full reference: [docs/api/configs.md](https://github.com/MicaFox-Platform/MicaFox/blob/main/docs/api/configs.md).
