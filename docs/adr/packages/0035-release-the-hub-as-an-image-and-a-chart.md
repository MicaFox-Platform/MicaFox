# 0035. Release the hub as an image and a chart

## Status

Accepted · 2026-11-20

## Context

The hub is not an npm package: operators run it from an image, with Docker Compose or a Helm chart, and need
versions, a changelog and images they can verify. Its code spans several private packages, so a change in any of
them changes the hub. The npm packages are released with Changesets through a version pull request into `staging`
and a release pull request into `main`
([ADR 0021](0021-version-and-publish-the-packages-with-changesets.md)).

## Decision

We version the hub as the private package `@micafox/hub` with Changesets, requiring a changeset for it on any change
under `packages/hub*/`, `packages/ui/` or `ee/`, and the release workflow pushes its image and Helm chart of that
version to GHCR with provenance when the release pull request merges.

## Alternatives

- **Versions from git tags by hand** — no changelog written for users, and a second release path to remember.
- **One version per hub package** — operators see one hub; versions of its inner packages mean nothing to them.
- **Docker Hub** — needs a long-lived token and has pull limits; GHCR works with the workflow's own token.

## Consequences

- `.changeset/config.json` versions private packages and ignores the hub's inner packages; `check-changesets.sh`
  covers the hub's paths, the chart and the Dockerfile included.
- Images are tagged `<version>`, `<major>.<minor>` and, for the highest version, `latest`; the chart has the same
  version; the GitHub Release carries the changelog and the Compose files.
- The basic hub image is built in CI and never pushed.
