# Configs

## Purpose

`@micafox/configs` holds shared presets for development tools (TypeScript, ESLint, Prettier and Vitest), so every
consumer configures them the same way instead of copying config. Today the consumers are the root, `packages/*`,
`examples/*` and `tools/*` of this monorepo. The presets are general and contain nothing specific to MicaFox, so the
package can also serve any TS/Node project that installs it from npm.

## Boundaries

- Owns: general presets per tool (`tsconfig/base.json`, `tsconfig/workspace.json`, `eslint`, `prettier`, `vitest`)
  and the ESLint plugins they need, bundled as dependencies.
- Does not own: repo-level orchestration and gates, such as the Vitest projects list, the coverage thresholds and the
  root `tsconfig.json` include list. Each repo keeps them in its own root config. It also does not own repo
  conventions such as the `@micafox/source` condition name, which the consumer passes in.
- Constraints:
  - Dev-time only: never a runtime dependency of the SDK or the host app.
  - Depends on no other MicaFox package.
  - `typescript`, `eslint`, `prettier` and `vitest` are optional peer dependencies, so a consumer installs only the
    tools it uses; what each preset needs is listed in the [API](../api/configs.md#installation).
  - A tool gets a preset once its config is shared by two or more consumers, inside or outside the monorepo.

## Interactions

```text
@micafox/configs ──────────┬── presets ─────────────▶ Repo root configs
                           ├── presets ─────────────▶ Workspace packages and examples
                           └─ ─ presets, from npm ─ ▶ Other TS/Node projects
```

Consumers apply a preset in their own config file and add their overrides on top.
Signatures and examples: [`docs/api/configs.md`](../api/configs.md).

| Preset                        | Applied with                                                            |
| ----------------------------- | ----------------------------------------------------------------------- |
| `tsconfig/base.json`          | `"extends"` in `tsconfig.json`                                          |
| `tsconfig/workspace.json`     | `"extends"` in a package's `tsconfig.json`                              |
| `tsconfig/workspace-cjs.json` | `"extends"` in a package's `tsconfig.cjs.json`, beside `workspace.json` |
| `eslint`                      | spread into the flat config array                                       |
| `prettier`                    | re-exported from `prettier.config.js`                                   |
| `vitest`                      | `createVitestConfig()` or the default export in a project config        |

## Key flows

### Running tests against sources

1. A workspace package exports the `@micafox/source` condition pointing at `src/index.ts`.
2. Its `vitest.config.ts` calls `createVitestConfig({ sourceCondition: "@micafox/source" })`.
3. Vitest resolves imports of workspace packages to their sources, so tests run without a build. A package without
   the condition resolves through its `default` export condition as usual.
4. The root `tsconfig.json` sets the same condition in `customConditions` and includes the tests, type tests and
   `vitest.config.ts` files, which `tsconfig/workspace.json` leaves out of each package's build; the root
   typecheck compiles them against the sources.

### Changing a preset

1. A preset changes in a regular pull request, see [making a change](../development.md#making-a-change).
2. Monorepo consumers use the preset through `workspace:*`, so the same pull request changes it and fixes every
   consumer; `pnpm verify` must pass.
3. A new or stricter error rule breaks the lint of consumers outside the monorepo, so it is released as a major
   version, or a minor one while the version is 0.x.
4. A setting that only one repo needs goes into that repo's own config, not into the preset.

## Decisions

- Presets are plain JavaScript with hand-written `.d.ts` files, and JSON for `tsconfig`. Tools load them directly,
  so lint, tests and typecheck need no build step, and the workspace uses the same files that npm ships.
- The source condition is a parameter of the Vitest preset, so no MicaFox name is baked into a published preset.
