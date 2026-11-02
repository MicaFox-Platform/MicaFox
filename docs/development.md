# Development

How to build, test and change ProbeX. To use ProbeX in an app, read the [README](../README.md) instead.

Before you change anything, read the [architecture overview](architecture/overview.md): what the parts are, how a
debugging session flows through them, and which [decisions](adr/) are already made.

## Repository

A pnpm monorepo in TypeScript (strict, NodeNext) with Vitest, ESLint and Prettier. Dependencies point down the
table only, and packages import each other by package name, never by relative path.

| Package               | Holds                                                         | May depend on |
| --------------------- | ------------------------------------------------------------- | ------------- |
| `packages/configs`    | shared tsconfig, ESLint, Prettier and Vitest presets          | -             |
| `packages/protocol`   | messages, `PROTOCOL_VERSION` and the `Connector` type         | -             |
| `packages/sdk`        | `src/debugger/` and `src/connector/`, run inside the host app | protocol      |
| `examples/node-basic` | demo app to try the SDK by hand                               | sdk, protocol |

A package exports its `src/index.ts` under the `@probex-platform/source` condition, which `pnpm dev`, tests and
typecheck resolve: packages read each other's sources directly, so development needs no build step.

## Setup

Requires Node.js ≥ 22 and pnpm 10.

```sh
git clone https://github.com/ProbeX-Platform/probex-platform.git
cd probex-platform
pnpm install   # install and link workspace packages, turn on the git hooks
pnpm verify    # everything must pass on a fresh clone
```

`pnpm install` also turns on the git hooks that check your work before it leaves the machine: see
[Checks](#checks).

## Commands

```text
pnpm dev        → every package and the demo app in watch mode (tsx --watch)
pnpm build      → build every package to dist/, dependencies first
pnpm typecheck  → typecheck every package, then the root files and tests
pnpm test       → one Vitest run over all packages
pnpm lint       → one ESLint run over the repo
pnpm format     → one Prettier check over the repo
pnpm verify     → lint → format → typecheck → test:coverage (≥ 80%), stops at the first failure
pnpm verify:fix → auto-fix lint and formatting
```

One package: `pnpm --filter @probex-platform/sdk test`, `pnpm --filter @probex-platform/node-basic dev`. CI runs
the same scripts on every pull request: see [Checks](#checks).

## Testing

- Unit tests live in the `__tests__/` folder of the folder that holds their module, so folders list only code.
  Tests that are not about one module (doc examples, lint boundaries, end-to-end) live in `packages/<name>/test/`,
  or in `examples/<name>/tests/` for the whole system; the configs package keeps all its tests there.
  Coverage of `packages/*/src` must stay ≥ 80% in lines, branches and functions; a line no meaningful test can
  reach is excluded in `vitest.config.ts` with the reason, never covered by a hollow test.
- Test behavior through the public surface. Mock only at the boundaries: the WebSocket, time and `node:inspector`.
- SDK code also tests its failure paths: it must prove it does not throw into or block the host app.
- Public types whose shape is the contract get type tests in `*.test-d.ts` with `expectTypeOf` and `assertType`.
  Vitest does not run them; `pnpm typecheck` compiles them and fails on a broken assertion.
- End-to-end tests run a component in a real Node process. A package keeps its own in
  `packages/<name>/test/e2e/<component>/`: a small fixture app started as a child process, and one test file per
  behavior of the component. Tests of the whole system, through the public API only, live in `examples/<name>/tests/`
  and start the example's app and fake hub as child processes.

Full rules: [testing](../.claude/rules/testing.md).

## Code quality

ProbeX runs inside other people's apps and is read by the developers who embed it, so the code is held to three
public guides. The rules distilled from them, with the parts that apply to an embedded Node.js library:

| Guide                                                                                                  | Rules                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)                      | [TypeScript](../.claude/rules/typescript.md), [code quality](../.claude/rules/code-quality.md) |
| [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)                            | [code quality](../.claude/rules/code-quality.md), [SDK](../.claude/rules/sdk.md)               |
| [JavaScript Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices) | [testing](../.claude/rules/testing.md)                                                         |

- **Structure.** Folders by component, each entered through its `index.ts`; at most 8 source files per folder,
  grouped into sub-component folders by concept; no empty folders. One concept per module, decisions kept apart
  from I/O. Functions by default; a class only for state with a lifecycle.
- **Naming.** Google's identifier rules: acronyms as words (`instanceId`), no `I` prefix, no `_` prefix except on
  an unused parameter, units in names (`timeoutMs`).
- **Efficiency.** Know the complexity of what you write; every cache, queue and buffer is bounded; the hot path is
  O(1) or O(n).
- **Where ProbeX differs from Google.** Arrow functions instead of function declarations, string-literal unions
  instead of enums, explicit return types on exports, `undefined` rather than `null`. Prettier owns formatting.

ESLint enforces every rule it can, including limits on file and function size, nesting, complexity and
parameters: see the [configs preset](api/configs.md#probex-platformconfigseslint). `pnpm lint` also runs
`.github/scripts/check-structure.sh` for the folder rules ESLint cannot check: files per folder, tests outside
`__tests__/` and empty folders.

## Making a change

1. **Design first.** A change to how parts work together updates [docs/architecture](architecture/overview.md) in
   the same PR, with an [ADR](adr/) when the choice is costly to reverse for users or peers.
2. **Public API.** A change to an export, option or environment variable updates [docs/api](api/overview.md) in the
   same PR.
3. **Protocol.** A change in `packages/protocol` stays backward-compatible or bumps `PROTOCOL_VERSION`:
   [changing the protocol](architecture/protocol.md#changing-the-protocol).
4. **SDK.** It runs in someone else's production app: never throw into, crash or block it; no sync I/O on the hot
   path; no new runtime dependency without an ADR. See [SDK rules](../.claude/rules/sdk.md).
5. **Check.** `pnpm verify`, then open a pull request to `staging` with a [named](#naming) branch and title.

Coding rules for TypeScript, the SDK, the protocol, tests, docs and ADRs: [.claude/rules](../.claude/rules/). AI
agents also follow [CLAUDE.md](../CLAUDE.md).

## Naming

| Name           | Rule                                  | Example                    | [Checked](#checks) by |
| -------------- | ------------------------------------- | -------------------------- | --------------------- |
| Branch         | `<type>/<kebab-case>`, ≤ 50 chars     | `feat/sdk-snapshots`       | AI agents only        |
| Commit subject | `<type>[(<scope>)][!]: <desc>`, ≤ 100 | `feat(sdk): add snapshots` | git hooks, CI         |
| PR title       | same as a commit subject              | `fix(protocol): empty ids` | CI                    |

- **Branch.** Lowercase `a-z`, `0-9` and single `-`. Branch from an up-to-date `staging`. `main` is release-only and
  accepts pull requests only from `staging`. A wrong branch name is cheap to live with, so only AI agents are held
  to it.
- **Commit subject.** [Conventional Commits](https://www.conventionalcommits.org): type and scope in any case,
  scope of `a-z`, `0-9` and `-`, `!` for a breaking change, one space after `:`. PRs go to `staging` and are merged
  with merge commits, so every commit lands in history and must follow the rule; merge commits themselves are
  exempt. A pushed commit takes a reword and a force-push to fix, which is why the git hooks check it first.
- **PR title.** Becomes the merge commit's title. Rename a PR with `gh pr edit <number> --title "…"`; CI re-runs.
  Release PRs from `staging` into `main` check only the title.

Use one of these types; release tooling maps them to the changelog and semver. A change that spans several types is
split into commits, or takes the main type and a scope: `ci(infra): …`.

| Type       | For                                            |
| ---------- | ---------------------------------------------- |
| `feat`     | new behavior for users of the packages (minor) |
| `fix`      | bug fix for users of the packages (patch)      |
| `perf`     | faster or lighter, same behavior               |
| `refactor` | code change with the same behavior             |
| `docs`     | documentation only                             |
| `test`     | tests only                                     |
| `build`    | build, dependencies, package and tool configs  |
| `ci`       | CI workflows, hooks and their scripts          |
| `chore`    | anything else that does not reach users        |
| `style`    | formatting only                                |
| `revert`   | reverts an earlier commit                      |

`.github/scripts/check-names.sh` is the source of these rules; CI and the git hooks run it, and it prints the rules
with examples on every failure. Check a name by hand: `bash .github/scripts/check-names.sh commit "<subject>"`.

## Checks

Each rule is checked as early as possible, where it is cheapest to fix. Every check prints `✓`, or what is wrong
and how to fix it.

```text
git commit ──▶ commit-msg ──▶ git push ──▶ pre-push ──▶ pull request ──▶ CI ──▶ review ──▶ merge
```

### On your machine

`pnpm install` points git at `.githooks/`:

| Hook         | Runs on      | Checks                                                                              |
| ------------ | ------------ | ----------------------------------------------------------------------------------- |
| `commit-msg` | `git commit` | the subject follows [Naming](#naming), before the commit exists                     |
| `pre-push`   | `git push`   | subjects of commits on no remote yet, then `pnpm verify` on the working tree (~7 s) |

- Merge commits and `fixup!`, `squash!`, `amend!` commits pass `commit-msg`; `pre-push` stops the ones left
  unsquashed: run `git rebase -i --autosquash <base>`.
- `--no-verify` skips a hook once; CI still runs the same checks.
- No hooks, in a clone made before them or after `pnpm install --ignore-scripts`? Run `pnpm install` again or
  `git config core.hooksPath .githooks`. Turn them off with `git config --unset core.hooksPath`.

### On a pull request

CI runs on every pull request into `staging` or `main`, and again on each new commit or rename. The `ci` job, in
order:

| Step            | Fails when                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------- |
| Only staging    | a pull request into `main` comes from a branch other than `staging`                         |
| PR title        | the title breaks [Naming](#naming); fix it with `gh pr edit <number> --title "…"`           |
| Commit messages | a non-merge commit subject breaks [Naming](#naming); skipped for release PRs from `staging` |
| Linter … Tests  | `pnpm lint`, `pnpm format`, `pnpm typecheck` or `pnpm test:coverage` fails                  |
| Build           | `pnpm build` fails                                                                          |

The `dependency-review` job fails when the pull request adds a dependency with a known vulnerability of high
severity or worse. Dependabot pull requests skip the name steps.

### Before merge

`main` and `staging` change only through pull requests: no direct or force pushes, no deletion. A pull request
merges when:

- `ci` and `dependency-review` are green;
- a [code owner](../.github/CODEOWNERS) approved it after its last push, and every review thread is resolved;
- every commit is [signed](https://docs.github.com/en/authentication/managing-commit-signature-verification).

Pull requests are merged with merge commits only, so every commit lands in history as it is. Pull requests from
forks wait for a maintainer to approve their CI run.

### AI agents

Claude Code runs these hooks from [.claude/settings.json](../.claude/settings.json) on top of the checks above:

| Hook             | Runs                      | Does                                                               |
| ---------------- | ------------------------- | ------------------------------------------------------------------ |
| `guard-git.sh`   | before each shell command | blocks bad branch names, work on `main`/`staging`, merges          |
| `format-file.sh` | after each file edit      | runs Prettier and `eslint --fix` on the file, reports what is left |
| `stop-verify.sh` | before the agent finishes | requires a green `pnpm verify` (`format` if only Markdown changed) |

Agents are also denied force-pushes, `gh pr merge` and edits to `pnpm-lock.yaml`.
