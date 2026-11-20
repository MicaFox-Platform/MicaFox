#!/usr/bin/env bash
# Checks the changesets of docs/development.md#releasing. Run from anywhere inside the repository.
# Usage: check-changesets.sh pr [<base>]   CI, on PRs into staging: a public package changed since <base> has a
#                                         changeset, and none is `major` while the package is 0.x;
#                                         a change to the hub has a changeset for @micafox/hub;
#                                         <base> defaults to origin/staging
#        check-changesets.sh release      CI, on PRs into main: no changeset that names a package is left
# Every failure says what is wrong and how to fix it.
set -uo pipefail

changeset="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/node_modules/.bin/changeset"
cd "$(git rev-parse --show-toplevel)" || exit 1

fail() {
  echo "✗ $1" >&2
  exit 1
}

# `changeset status` finds changed files and new changesets through `git diff`, which lists no untracked file
check_tracked() {
  local untracked
  untracked=$(git ls-files --others --exclude-standard -- .changeset packages ee)
  [[ -z $untracked ]] || fail "untracked files are not checked, git add them first:
$(sed 's/^/  /' <<<"$untracked")"
}

# The image and chart of @micafox/hub are built from all the hub's packages and ee/, but `changeset status` sees only
# the shipped files of @micafox/hub itself, the others being ignored: ADR 0035. Tests do not reach the image.
check_hub() {
  local base=$1 plan=$2 fork changed
  # As `changeset status --since` does: changes of this branch and uncommitted ones, not those merged into the base
  fork=$(git merge-base "$base" HEAD) || fail "$base and HEAD have no common commit: rebase onto $base"
  changed=$(git diff --name-only "$fork" |
    grep -E '^(packages/(hub[^/]*|ui)|ee)/' | grep -Ev '^(packages/[^/]+|ee/[^/]+)/test/|/__tests__/')
  [[ -z $changed ]] && return 0
  node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const isHub = ({ releases }) => releases.length === 0 || releases.some(({ name }) => name === "@micafox/hub");
    process.exit(plan.changesets.some(isHub) ? 0 : 1);
  ' "$plan" ||
    fail "the hub changed since $base without a changeset for @micafox/hub: run pnpm changeset and pick @micafox/hub, or pnpm changeset --empty when hub users see no change; changed:
$(sed 's/^/  /' <<<"$changed")"
}

# `changeset status` uses the same changedFilePatterns and private-package rules as `pnpm changeset`
check_pr() {
  local base=$1 plan majors out
  [[ -x $changeset ]] || fail "$changeset is missing: run pnpm install"
  # Else changeset status fails as if a changeset were missing
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null ||
    fail "unknown base $base: fetch it (git fetch origin staging) or pass an existing ref"
  check_tracked
  plan=$(mktemp)
  # shellcheck disable=SC2064 # expand now: $plan is local
  trap "rm -f '$plan'" EXIT
  if ! out=$("$changeset" status --since="$base" --output="$plan" 2>&1); then
    echo "$out" >&2
    [[ $out == *"no changesets were found"* ]] &&
      fail "a public package or the hub changed since $base without a changeset: run pnpm changeset, or pnpm changeset --empty when its users see no change"
    fail "changeset status failed: see above"
  fi

  # While a package is 0.x a breaking change is minor: ADR 0021
  majors=$(node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const versions = new Map(plan.releases.map((release) => [release.name, release.oldVersion]));
    for (const { id, releases } of plan.changesets)
      for (const { name, type } of releases)
        if (type === "major" && versions.get(name)?.startsWith("0."))
          console.log(`  .changeset/${id}.md: ${name} is ${versions.get(name)}`);
  ' "$plan") || fail "could not read the release plan of changeset status"
  [[ -z $majors ]] ||
    fail "major changeset for a 0.x package; a breaking change is minor until 1.0, edit the bump:
$majors"
  check_hub "$base" "$plan"
  echo "✓ changesets"
}

# Empty changesets name no package: the version PR is never opened for them alone, so they may reach main
check_release() {
  local file left=()
  for file in .changeset/*.md; do
    [[ -f $file && $file != .changeset/README.md ]] || continue
    awk '/^---[[:space:]]*$/ { fences++; next } fences == 1 && NF { named = 1 } END { exit !named }' "$file" &&
      left+=("$file")
  done
  ((${#left[@]} == 0)) ||
    fail "changesets left: $(printf '%s ' "${left[@]}")
  merge the version pull request (chore(release): version packages) into staging first"
  echo "✓ no changeset left"
}

case ${1:-} in
  pr) check_pr "${2:-origin/staging}" ;;
  release) check_release ;;
  *) fail "usage: check-changesets.sh pr [<base>] | release" ;;
esac
