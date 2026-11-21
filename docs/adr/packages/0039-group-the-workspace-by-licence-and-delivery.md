# 0039. Group the workspace by licence and delivery

## Status

Accepted · 2026-11-21

## Context

The repository holds code under three licences that ships three ways: MIT building blocks published to npm
(`protocol`, `sdk`, `configs`) or reusable outside the hub (`ui`,
[ADR 0022](0022-split-the-hub-into-packages-by-role.md)); the AGPL-3.0-only hub, shipped only as an image; the
proprietary `ee/` extension inside that image
([ADR 0023](../hub/app/0023-build-the-open-core-and-ee-from-one-app-with-ee.md)); and apps that only exercise the SDK. Until now everything but `ee/` sat in `packages/`, next to `examples/`, so the
licence of a file and whether it ships could only be read from a table, and every licence, changeset and coverage
check matched names such as `packages/hub*`. More hub features and the paid extension are coming, and each must land
under the right licence and checks without a change to them. Package names are public in imports and in the hub's
image, and must not change.

## Decision

We group the workspace by top folder, which tells the licence and how the code ships: `packages/` for the MIT
building blocks, `hub/` for the AGPL-3.0-only open hub (`hub/core`, `hub/<feature>`, `hub/app`), `ee/` for the
proprietary extension (`ee/hub`), `sandbox/` for the apps that exercise the SDK, and `tools/` for the private test
kit; package names stay as they are.

## Alternatives

- **Today's layout, everything in `packages/`** — the licence of a package is only in its manifest and a table;
  `packages/hub*` globs in the licence, changeset and lint checks would catch a new package only by its name.
- **`apps/` and `packages/`** — splits by "runs" versus "is imported", which mixes MIT and AGPL code in both
  folders: `packages/` would hold the AGPL `hub-core` and features next to the MIT SDK, and `apps/` the AGPL hub
  next to the MIT sample apps, so licences still need a table.

## Consequences

- A checked licence per folder: `check-licences.sh` requires MIT under `packages/`, AGPL-3.0-only under `hub/` and
  the owner's terms under `ee/`; the workspace, TypeScript, Vitest coverage, ESLint, structure and changeset checks
  match `hub/*` and `ee/*`, so a new feature or `ee/hub` needs no change to them.
- ESLint rules are written by folder: `packages/` never imports `hub/`, `ee/`, `tools/` or `sandbox/`; `hub/` takes
  only `protocol` and `ui` from `packages/`; only `hub/app` imports `ee/`; product code never imports the test kit
  or `sandbox/`.
- Paths that name `examples/` or `packages/hub*`, such as the repository paths of the sandbox apps' breakpoints,
  change once; imports do not, since packages import each other by name.
