# 0023. Build the open core and ee/ from one app with #ee

## Status

Accepted · 2026-11-20

## Context

One official image serves self-hosted teams and Cloud, with paid features unlocked by entitlements. The open part
must stay complete and useful without `ee/`, and that must be proven on every pull request, not trusted. A solo
developer maintains both, so two apps or two Dockerfiles would drift. The proprietary code must never end up in the
open build.

## Decision

We build both from `hub/app`, which imports the extension only as `#ee` and `#ee/web`: its `imports` field
maps them to `@micafox/hub-ee` by default and to empty stubs under the build condition `micafox-open-core`
(`EE=false`); CI builds that open "basic hub" and fails when any path from `ee/` is in its bundles or its image.

## Alternatives

- **Two apps, `hub/app` and `ee/apps/hub` that wraps it** — two entry points, two Dockerfiles and two sets of
  build settings that drift; nothing proves the open app is the one users get.
- **Loading `ee/` at run time from a plugin folder** — no type checking across the boundary, a plugin folder is an
  attack surface, and an image without the folder proves little about the code.
- **A fork or a private repository for the paid build** — every change merged twice.

## Consequences

- The build condition is set in one helper used by esbuild, Vite, Vitest and Node; Vite's defaults have to be kept
  next to it. `pnpm typecheck` checks both variants, so the stubs match the extension's type.
- The ESLint rule "no package imports `ee/`" has exactly one exception: `#ee` in `hub/app`.
- The workspace includes `ee/*`; `ee/` code reaches the app only through the imported extension, never from disk.
- The basic hub image is built in CI only and never published.
