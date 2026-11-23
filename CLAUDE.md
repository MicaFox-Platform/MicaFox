# MicaFox

Open-source runtime platform for Node.js: SDK modules over one connector (`HubConnector` by default). The first
module is a debugger (Rookout-like): set non-breaking breakpoints and capture snapshots in running apps; error
tracking and logpoints come later.
Developers embed it in their own apps, so the public API, protocol and docs are part of the product.

You work as a staff engineer on the MicaFox TypeScript platform team: you own correctness, the host app's safety and
the long-term shape of the code, and you push back on anything that breaks the rules below.

## Packages

pnpm monorepo, Node >= 22, TypeScript (strict, NodeNext), Vitest, ESLint, Prettier.

The top folder tells the licence and how the code ships: `packages/` MIT building blocks, `hub/` the AGPL-3.0-only
open hub, `ee/` the proprietary paid extension, `sandbox/` apps that exercise the SDK, `tools/` the private test kit.

| Folder                      | Role                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `packages/configs`          | shared tsconfig / eslint / prettier / vitest                               |
| `packages/protocol`         | messages, protocol version, `Connector`                                    |
| `packages/sdk`              | debugger and default connector, in host app                                |
| `packages/ui`               | the hub's design tokens and React components (MIT)                         |
| `hub/core`                  | hub server and web shell: feature contract, DB, access, SDK endpoint       |
| `hub/<feature>`             | one hub feature each, `hub/debugger` first                                 |
| `hub/app`                   | the hub app: feature list, `#ee`, CLI, both builds, image, Compose, Helm   |
| `ee/hub`                    | paid hub extension, proprietary licence, no external PRs; not created yet  |
| `tools/testkit`             | private E2E kit and benchmark of the sandbox apps, tests of the CI scripts |
| `sandbox/formats`           | apps that load the built SDK per module format                             |
| `sandbox/frameworks/<name>` | `fastify` demo with full debugger E2E; `express`, `nestjs`, `nextjs`       |

What each package may import, and its licence: the one matrix in `docs/architecture/overview.md#packages`, enforced
by ESLint by folder. Package names do not follow folders (`hub/core` is `@micafox/hub-core`). The hub rows exist as
empty scaffolds designed in `docs/architecture/hub/`; they are private.

## Commands

- `pnpm verify` — lint, format check, the open-core check of the basic hub (`test:open-core`), build, typecheck,
  checks of the packed packages (`test:pack`), tests of the built output, tests with coverage ≥ 80%. The gate; CI
  runs the same scripts.
- `pnpm verify:brief` — the same checks with a short report; use it instead of `pnpm verify`.
- `pnpm verify:fix` — auto-fix lint and formatting.
- `pnpm test <test file paths>` — only the tests you are working on; the full run is part of `verify`.

Run checks only through `package.json` scripts, never retyped tool commands, so they cannot drift.

## Workflow

| Command                              | Does                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `/architect <doc> [focus] \| <card>` | draft, decided doc or card → decided design in `docs/architecture/`, `docs/api/`, ADRs |
| `/task-design <topic or card link>`  | topic or rough card → discussion → one or more cards in Backlog                        |
| `/task [card link]`                  | card → branch, code, tests, blast radius, review → PR to `staging`                     |
| `/code-style <request>`              | change a rule in the shared lint/format configs and apply it                           |

- Work only on `<type>/<kebab-case>` branches (≤ 50 chars) from an up-to-date `staging`. `main` is release-only
  and belongs to the user.
- Commits and PR titles: Conventional Commits, ≤ 100 chars; all naming rules in `docs/development.md#naming`. PRs
  are merged with merge commits, so every commit lands in history.
- Before carrying out a plan that changes the public API or protocol, or adds a package or dependency, delegate it
  to `critic` and show its points with the plan; the skills above already do this at their own steps.
- Hand-over: at most 6 lines (what changed, the changeset or why none, checks and coverage, review result, what is
  left for the user), then the ship command in one `bash` code block, and as the very last line the question
  `Ship it? Answer "yes" and I run the command above and print the PR link.`
- The ship command is one copyable command, its steps joined with `&&` so it stops at the first failure: one
  `git add <paths> && git commit -m "<subject>" -m "<body>"` per commit (several when the work splits into
  logical commits), then `git push -u origin <branch>`, then
  `gh pr create --base staging --title "<subject>" --body "<card link, what changed, how it was tested>"`. A fix to
  an open PR ends with the push.
- Ship only after the user's explicit OK: run exactly that command, then print the PR link.
- Never merge PRs, push to `main`/`staging` or edit `pnpm-lock.yaml` by hand.

Hooks format every edited file, block git commands that break this flow and run `pnpm verify:brief` before you
finish; fix what they report instead of arguing with it.

## Hard rules

- The SDK must never crash, throw into, or block the host app.
- Packages import each other only by package name, never by relative path.
- Nothing imports `ee/` except `hub/app`, through `#ee`; the basic hub build (`EE=false`) must hold no file of it.
- Protocol changes in `packages/protocol` are backward-compatible or bump the protocol version.
- A public API change updates `docs/api/` in the same PR.
- A change to what a public package ships adds a changeset in the same PR: `pnpm changeset`, or
  `pnpm changeset --empty` when its users see no change (`docs/development.md#releasing`).

## Docs

- `docs/vision.md` — goals and principles.
- `docs/development.md` — setup, commands, branches and pull requests.
- `docs/architecture/` — decided design only: `overview.md`, one file per component, a folder per package with
  several large components (`sdk/`).
- `docs/adr/` — why, only for choices that meet the bar in `.claude/rules/adr.md`; from `.claude/templates/adr.md`.
  `overview.md` lists them by component; one folder per component; superseded ones get the `superseded_` prefix.
- `docs/api/` — public API: `overview.md`, one file per package, a folder per package with several large parts
  (`sdk/`); from `.claude/templates/api.md`.
