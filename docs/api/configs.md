# @micafox/configs API

## Installation

```sh
pnpm add -D @micafox/configs
```

`eslint`, `prettier`, `typescript` and `vitest` are optional peer dependencies: install what the presets you use
need. The ESLint plugins come bundled.

| Preset     | Needs                              |
| ---------- | ---------------------------------- |
| `tsconfig` | `typescript` >= 5.8, `@types/node` |
| `eslint`   | `eslint` ^10, `typescript` >= 5.8  |
| `prettier` | `prettier` ^3                      |
| `vitest`   | `vitest` ^4                        |

## Exports

### `@micafox/configs/tsconfig/base.json`

```json
{ "extends": "@micafox/configs/tsconfig/base.json" }
```

Strict TypeScript for Node: `ES2024`, `NodeNext` modules, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
and `verbatimModuleSyntax`.

### `@micafox/configs/tsconfig/workspace.json`

```json
{ "extends": "@micafox/configs/tsconfig/workspace.json" }
```

`base.json` plus a composite build of one monorepo package: compiles `src/` to `dist/` with declarations and source
maps. `*.test.ts` and `*.test-d.ts` are left out of the build and are not typechecked there; the root
`tsconfig.json` typechecks them, see [Usage](#usage). Paths are relative to the extending `tsconfig.json`.

### `@micafox/configs/eslint`

```ts
declare const config: Linter.Config[];
export default config;
```

Flat config: `@eslint/js` recommended, typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`, and the
Vitest recommended rules for `*.test.ts` and `*.test-d.ts`. It lints `*.ts` files with type information; `*.js`,
`*.d.ts`, `dist/`, `coverage/` and `node_modules/` are ignored, and other extensions get the base rules only. On top
of those presets, the highlights:

- **Size and shape:** at most 300 lines per file and 50 per function, not counting blank lines and comments (tests
  exempt), nesting depth 3, cyclomatic complexity 10, 3 parameters.
- **Style:** arrow functions, named exports only (default exports allowed in `*.config.ts`), `===` except
  `== null`, `const`, no `enum`, `for...in`, `#private`, nested ternaries, `else` after `return` or reassigned
  parameters, `T[]` only for simple element types, object literals annotated rather than asserted, no TODO-style
  comments.
- **Imports:** sorted, no duplicates, no cycles, no relative imports into another package.
- **Naming:** `camelCase`; `UPPER_CASE` also for constants and static readonly properties; `PascalCase` for types
  and imports; a leading `_` only on parameters; no `I` prefix on interfaces; destructured names and quoted
  property names unchecked.
- **Types:** explicit return types on exports, `readonly` for private fields never reassigned, exhaustive `switch`
  on unions and `default` on others.
- **Tests:** no skipped tests, no conditionals, a message on every `toThrow`, `describe` nested at most twice.

```js
import config from "@micafox/configs/eslint";

export default [
  ...config,
  { rules: { "max-lines-per-function": "off", "@typescript-eslint/max-params": ["error", { max: 4 }] } },
];
```

Type-aware rules find each file's `tsconfig.json` through the typescript-eslint project service. In a monorepo
whose root `tsconfig.json` owns files outside the package tsconfigs, such as tests and `vitest.config.ts`, set
`tsconfigRootDir` in the root ESLint config; otherwise editors that run ESLint from a package directory report those
files as not found:

```js
export default [...config, { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } }];
```

### `@micafox/configs/prettier`

```ts
declare const config: Config;
export default config;
```

Prettier options: 120 columns, double quotes, semicolons, trailing commas.

```js
export { default } from "@micafox/configs/prettier";
```

### `createVitestConfig()`

```ts
const createVitestConfig: (options?: VitestConfigOptions) => UserWorkspaceConfig;
```

Builds the Vitest project config: runs `**/*.test.ts`, keeps Vitest's default excludes and skips `dist/`.
`*.test-d.ts` files are not run; typecheck them with `tsc`.

**Parameters**

- `options` — [`VitestConfigOptions`](#vitestconfigoptions), optional.

**Returns** `UserWorkspaceConfig`, ready to export from `vitest.config.ts` or to pass to `mergeConfig()`.

**Errors** — none.

```ts
import { createVitestConfig } from "@micafox/configs/vitest";

export default createVitestConfig({ sourceCondition: "@acme/source" });
```

### `VitestConfigOptions`

```ts
interface VitestConfigOptions {
  sourceCondition?: string;
}
```

- `sourceCondition` — `string`, optional. An export condition resolved before Vite's defaults in both the client and
  server environments, so tests import workspace packages from their sources without a build. Without it, or when
  it is empty, Vite's default conditions apply.

### `@micafox/configs/vitest` default export

```ts
declare const config: UserWorkspaceConfig;
export default config;
```

The result of `createVitestConfig()` without options.

```ts
export { default } from "@micafox/configs/vitest";
```

## Usage

A monorepo package `@acme/lib` exports its sources under a source condition next to its built entry. The condition
comes before `types` and `default`: conditions match in key order, so after `default` Vitest silently runs tests
against `dist/`, and after `types` tsc typechecks against the built declarations.

```json
{
  "exports": {
    ".": {
      "@acme/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

Its `tsconfig.json` and `vitest.config.ts`, and the repo's root `tsconfig.json`, which typechecks the tests, type
tests and Vitest configs against the sources:

```json
{ "extends": "@micafox/configs/tsconfig/workspace.json" }
```

```json
{
  "extends": "@micafox/configs/tsconfig/base.json",
  "compilerOptions": { "noEmit": true, "customConditions": ["@acme/source"] },
  "include": ["packages/*/vitest.config.ts", "packages/*/src/**/*.test.ts", "packages/*/src/**/*.test-d.ts"]
}
```

```ts
import { createVitestConfig } from "@micafox/configs/vitest";
import { defineProject, mergeConfig } from "vitest/config";

export default mergeConfig(
  createVitestConfig({ sourceCondition: "@acme/source" }),
  defineProject({ test: { testTimeout: 10_000 } }),
);
```

ESLint and Prettier configs live in the repo root, as in the examples under [Exports](#exports).
