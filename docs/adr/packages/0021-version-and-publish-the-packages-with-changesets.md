# 0021. Version and publish the packages with Changesets

## Status

Accepted · 2026-11-17

## Context

`@micafox/sdk` runs in host apps, `@micafox/protocol` is imported by custom connectors and hubs, and
`@micafox/configs` by any TypeScript project. Their users need versions that follow semver, a changelog written for
them and proof that a tarball was built from this repository. The repository constrains how a release happens:

- `main` is release-only and accepts pull requests only from `staging`.
- Pull requests merge with merge commits, so every change lands in history twice with the same Conventional Commit
  subject: the commit and its pull request's merge commit.
- Every pull request needs signed commits, a code owner's approval and the `ci` check, bot pull requests included.
- Compatibility between peers is carried by [`PROTOCOL_VERSION`](../../api/protocol.md#protocol_version), not by
  package versions.

## Decision

We version each public package on its own with Changesets: a pull request that changes one carries a changeset, a
version pull request into `staging` applies them, and a push to `main` publishes the new versions from CI with npm
trusted publishing and provenance.

## Alternatives

- **release-please** — versions and changelogs from Conventional Commits: with merge commits every change appears
  twice, entries are commit subjects rather than notes for users, and its release pull request targets `main`,
  which accepts pull requests only from `staging`.
- **semantic-release** — publishes on every push with no reviewed version step, and supports monorepos only through
  plugins.
- **One version for all packages** — a fix in one package would release the others unchanged, and peers already
  agree on compatibility through `PROTOCOL_VERSION`.
- **An npm token in CI secrets** — a long-lived secret that can publish every package; trusted publishing needs none
  and adds provenance.

## Consequences

- Each package has its own version, `CHANGELOG.md`, `@micafox/<package>@<version>` tags and GitHub Releases, and
  every version on npm carries provenance.
- Commit types no longer decide versions; the changeset does. CI requires one on pull requests that change a public
  package, except the version pull request, release pull requests and Dependabot.
- While a package is 0.x, a breaking change is a minor version and CI rejects `major` changesets. For
  `@micafox/configs`, a new error rule or a stricter compiler flag is breaking: [configs](../../architecture/configs.md).
- `@micafox/sdk` depends on `@micafox/protocol` as `workspace:^`, published as a caret range, so an app that also
  installs the protocol gets one copy.
- The first publish of `@micafox/protocol` freezes protocol version 1:
  [changing the protocol](../../architecture/protocol.md#changing-the-protocol).
- Follow-up: the release workflow and its CI checks, `publishConfig.exports` without the source condition, and the
  first publish of each package with a one-time token before trusted publishing takes over. `@micafox/sdk` and
  `@micafox/protocol` stay private until their first release.
