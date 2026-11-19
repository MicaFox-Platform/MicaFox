#!/usr/bin/env bash
# Adds the GitHub Release, and with it the tag, of every public package version that is on npm and has no Release
# yet: docs/development.md#releasing. Safe to re-run: a version that has its Release is skipped, so a run that died
# after `changeset publish` finishes what is missing and never duplicates. Run by the release workflow after the
# publish. Every failure says what is wrong and how to fix it.
# Env: GH_TOKEN (gh), GITHUB_REPOSITORY (gh outside a clone), GITHUB_SHA (the commit to tag; default: HEAD)
set -uo pipefail

status=0

fail() {
  echo "✗ $1" >&2
  status=1
}

cd "$(git rev-parse --show-toplevel)" || exit 1
sha=${GITHUB_SHA:-$(git rev-parse HEAD)}
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT

# The lines of `## <version>` up to the next `## `: what `changeset version` wrote for this release
changelog_section() {
  awk -v heading="## $2" '
    /^## / { printing = ($0 == heading); next }
    printing { print }
  ' "$1"
}

for manifest in packages/*/package.json; do
  jq -e '.private != true' "$manifest" >/dev/null || continue
  dir=$(dirname "$manifest")
  name=$(jq -r '.name' "$manifest")
  version=$(jq -r '.version' "$manifest")
  tag="$name@$version"

  # Only what npm has: a version that failed to publish gets no Release. `changeset publish` tags what it published in
  # this run, and that tag is the answer: the registry caches metadata for minutes, so npm may not list it yet. A re-run
  # on a fresh runner has no such tag and asks npm
  if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
    :
  elif ! published=$(npm view "$tag" version 2>&1); then
    if [[ $published == *E404* ]]; then
      echo "- $tag: not on npm, skipped"
    else
      fail "$tag: could not ask npm whether it is published: $published; re-run the job"
    fi
    continue
  fi

  if ! existing=$(gh release view "$tag" 2>&1); then
    [[ $existing == *"release not found"* ]] || {
      fail "$tag: could not ask GitHub whether it has a Release: $existing; re-run the job"
      continue
    }
  else
    echo "- $tag: has its Release, skipped"
    continue
  fi

  changelog_section "$dir/CHANGELOG.md" "$version" >"$notes" 2>/dev/null
  if [[ ! -s $notes ]]; then
    fail "$tag: $dir/CHANGELOG.md has no \"## $version\" section: run changeset version through the version pull request"
    continue
  fi

  # Creates the tag on $sha when it does not exist; one Release per package, so none of them is "latest"
  if gh release create "$tag" --target "$sha" --title "$tag" --notes-file "$notes" --latest=false >/dev/null; then
    echo "✓ $tag: tag and Release created"
  else
    fail "$tag: gh release create failed: check the token's contents: write permission, then re-run the job"
  fi
done

exit "$status"
