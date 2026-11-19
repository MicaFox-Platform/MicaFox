#!/usr/bin/env bash
# Every action a workflow uses is pinned by its full commit SHA, with its version in a comment:
# `uses: owner/repo@<40 hex> # vX.Y.Z`. A tag can be moved to other code, a commit cannot; Dependabot updates the SHA
# and the comment together. Actions of this repo (`./`) and `docker://` images are exempt. Run by `pnpm lint`.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

status=0

while IFS= read -r match; do
  file=${match%%:*}
  rest=${match#*:}
  line=${rest%%:*}
  text=${rest#*:}
  # The reference alone: the key, quotes and a trailing comment stripped
  ref=$(sed -E "s/^[[:space:]-]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//; s/[\"']//g" <<<"$text")
  [[ $ref == ./* || $ref == docker://* ]] && continue
  if [[ ! $ref =~ @[0-9a-f]{40}$ || ! $text =~ \#[[:space:]]*v[0-9] ]]; then
    echo "✗ $file:$line uses $ref: pin it by its full commit SHA with the version in a comment, as owner/repo@<sha> # vX.Y.Z" >&2
    status=1
  fi
done < <(grep -nHE '^[[:space:]-]*uses:' .github/workflows/*.yml .github/workflows/*.yaml .github/actions/*/action.yml 2>/dev/null)

((status == 0)) && echo "✓ actions pinned by commit"
exit "$status"
