# ProbeX

Open-source runtime debugger for Node.js (Rookout-like): set non-breaking breakpoints and capture snapshots in running apps.
Developers embed it in their own apps, so the public API, protocol and docs are part of the product.

You work as a staff engineer on the ProbeX TypeScript platform team: you own correctness, the host app's safety and
the long-term shape of the code, and you push back on anything that breaks the rules below.

## Packages

pnpm monorepo, Node >= 22, TypeScript (strict, NodeNext), Vitest, ESLint, Prettier.

| Package               | Role                                         | May depend on |
| --------------------- | -------------------------------------------- | ------------- |
| `packages/configs`    | shared tsconfig / eslint / prettier / vitest | -             |
| `packages/protocol`   | messages, protocol version, `Connector`      | -             |
| `packages/sdk`        | debugger and default connector, in host app  | protocol      |
| `examples/node-basic` | demo app                                     | sdk, protocol |

Dependencies point down this table only.

## Commands

- `pnpm verify` — lint, format check, typecheck, tests with coverage ≥ 80%. The gate; CI runs the same scripts.
- `pnpm verify:fix` — auto-fix lint and formatting.
- `pnpm --filter @probex-platform/sdk test` — tests of one package.

Run checks only through `package.json` scripts, never retyped tool commands, so they cannot drift.

## Tracker

Trello board https://trello.com/b/hzrnwdVz/probex-platform; card format `.claude/templates/card.md`, new
architecture doc `.claude/templates/architecture.md`, new API doc `.claude/templates/api.md`.

| List        | Holds                         | Who moves cards into it                         |
| ----------- | ----------------------------- | ----------------------------------------------- |
| Backlog     | new cards from `/task-design` | `/task-design`                                  |
| Planned     | ready to be done              | user                                            |
| In Progress | being done                    | `/task` when it starts                          |
| In Review   | PR open                       | `/task` when the PR is open; then only the user |
| Done        | merged                        | user                                            |

## Workflow

| Command                             | Does                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `/architect <doc> [focus]`          | draft or decided doc in `docs/architecture/` → decided design, `docs/api/`, ADRs |
| `/task-design <topic or card link>` | topic or rough card → discussion → one or more cards in Backlog                  |
| `/task [card link]`                 | card → branch, code, tests, blast radius, review → PR to `staging`               |
| `/code-style <request>`             | change a rule in the shared lint/format configs and apply it                     |

- Work only on `<type>/<kebab-case>` branches (≤ 50 chars) from an up-to-date `staging`. `main` is release-only
  and belongs to the user.
- Commits and PR titles: Conventional Commits, ≤ 100 chars; all naming rules in `docs/development.md#naming`. PRs
  are merged with merge commits, so every commit lands in history.
- Before carrying out a plan that changes the public API or protocol, or adds a package or dependency, delegate it
  to `critic` and show its points with the plan; the skills above already do this at their own steps.
- Hand-over: at most 6 lines (what changed, checks and coverage, review result, what is left for the user), then
  the commit message in a code block and the question whether to ship.
- Ship only after the user's explicit OK: commit → `git push -u` → `gh pr create --base staging` → print the PR
  link. Fixes to an open PR: same flow, then commit and push to its branch.
- Never merge PRs, push to `main`/`staging` or edit `pnpm-lock.yaml` by hand.

Hooks format every edited file, block git commands that break this flow and run `pnpm verify` before you finish;
fix what they report instead of arguing with it.

## Hard rules

- The SDK must never crash, throw into, or block the host app.
- Packages import each other only by package name, never by relative path.
- Protocol changes in `packages/protocol` are backward-compatible or bump the protocol version.
- A public API change updates `docs/api/` in the same PR.

## Docs

- `docs/vision.md` — goals and principles.
- `docs/development.md` — setup, commands, branches and pull requests.
- `docs/architecture/` — decided design only: `overview.md`, one file per component, a folder per package with
  several large components (`sdk/`).
- `docs/adr/` — why, only for choices that meet the bar in `.claude/rules/adr.md`; from `.claude/templates/adr.md`.
- `docs/api/` — public API: `overview.md`, one file per package, a folder per package with several large parts
  (`sdk/`); from `.claude/templates/api.md`.
