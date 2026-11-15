# 0020. Find a bundle by reading maps on demand

## Status

Accepted · 2026-11-15

## Context

The hub sets a breakpoint by the file's path in the repository. The debugger finds the script it runs in by name: a
script without a map whose file name equals the breakpoint's, or the map of a script whose base name does
(`dist/checkout.js` for `src/checkout.ts`), and it reads no other map. A bundle never matches: esbuild writes
`dist/server.cjs`, and `next build` puts a route handler into `.next/server/chunks/[root-of-the-server]__….js`, while
`route.js` only loads the chunks and has no map. So every breakpoint in bundled output stays `pending`, which rules out
Next.js and any app shipped through a bundler. The users' docs said so and asked them to keep compiled file names equal
to their sources'.

Matching by name has a second flaw that bundles make common: packages ship their compiled files with maps too. In
Next.js 16, 2,425 files of `next/dist` have one, with sources such as `../../src/server/utils.ts`, so the app's own
`src/server/utils.ts` resolves into Next's code, or ties with it and gets `error`.

Only a map tells which sources a bundle holds, and reading one costs I/O, up to 8 MiB of text and parsing time in the
host process. Without breakpoints the debugger must cost the app nothing. Bundles carry no common marker: their names
and folders differ by bundler and version.

## Decision

We never resolve a breakpoint into `node_modules`, and when no script matches its whole path by name, we read the
maps of the app's other scripts with a map, one at a time, keep their sources by file name, and search those too,
also in scripts that load later.

## Alternatives

- **Read every map when its script loads** — no breakpoint ever waits for a search, but every app with source maps pays
  the reads for all its scripts as soon as it has a breakpoint, also when every breakpoint matches by name.
- **A user option that lists the bundles** — nothing is guessed and nothing extra is read, but every app with a bundle
  needs one more setting, a public option to keep forever, and a wrong path leaves breakpoints `pending` with no hint.
- **Search the maps in `node_modules` too** — finds a breakpoint in a package shipped as a bundle, but packages' own
  sources then shadow the app's files, and a search reads the maps of thousands of compiled package files.
- **Recognize bundles by their names** (`.next/server/chunks/`, `[root-of-the-server]`) — reads fewer maps, but breaks
  with every bundler and version that names its output differently.

## Consequences

- Breakpoints resolve in esbuild, webpack, Rollup and Next.js output with standard source maps, with no setting, and the
  same-name rule is no longer needed. The rules of a match stay: the longest matching path wins, two different paths
  that match as well give `error`, no match is `pending`. A file that several scripts hold, such as one that two chunks
  bundle, gets the breakpoint in each.
- A breakpoint on a file that matches nothing by name, such as a typo or a file not loaded yet, reads the maps of the
  app's own scripts once each, and so does one whose repository path is longer than the deployed path, as in a monorepo.
  The sources found are kept up to a fixed limit, so the next such breakpoint reads nothing again; see
  [the debugger's memory bounds](../../../architecture/sdk/debugger.md#boundaries).
- A breakpoint in a dependency, or in an app that runs its own code from under `node_modules`, such as one installed as
  a package or run with `--preserve-symlinks`, stays `pending`.
- A bundle map over the size limits gives the breakpoint `error` with the reason when nothing else matches, so the hub
  shows why instead of `pending`.
- A chunk that a bundler loads on first use, such as a Next.js route's, is read only after it loads, so its first use
  runs before the breakpoint is set, as the first run of a module's top-level code can already.
