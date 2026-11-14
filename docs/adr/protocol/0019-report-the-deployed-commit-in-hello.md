# 0019. Report the deployed commit in hello

## Status

Accepted · 2026-11-11

## Context

The hub sets breakpoints by a path and line in the repository and shows them next to the source. To show the right
source, and to warn when a line no longer means what it did, it needs the commit each app instance runs. Apps run
on many platforms and CI systems, each with its own variable for the commit, and the SDK must not read the disk or
run `git` at startup. Like the service and labels, the commit differs per deployment and is set by whoever deploys
the app.

## Decision

We send the deployed commit as an optional `commit` field of `hello`, from the `commit` option or `MICAFOX_COMMIT`,
resolved like `service`.

## Alternatives

- **A `commit` label** — no new field, but the hub would rely on a naming convention that users may not follow, and
  a label cannot be checked for a valid commit hash.
- **Detecting the commit from known CI and platform variables** — less setup, but the list of variables
  (`GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`, `SOURCE_VERSION` and more) becomes public API to
  keep up with every platform, and it guesses wrong when a variable from the build leaks into the runtime.
- **Reading `.git` at startup** — disk I/O in the host app, and deployed images usually have no `.git`.

## Consequences

- `MICAFOX_COMMIT` is public API: the deployment pipeline sets it next to `MICAFOX_SERVICE`.
- The SDK sends only a commit hash: 7 to 64 hexadecimal characters, lowercased; anything else is left out with a
  warning, so the hub can trust the field.
- Without the variable, the hub does not know the commit and treats the instance as running an unknown one.
