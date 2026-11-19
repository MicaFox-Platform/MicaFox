#!/usr/bin/env bash
# Stop: Claude may finish only when `pnpm verify` is green, run as `verify:brief` for a short report (`format` alone
# for Markdown-only changes).
# Silent when green, when nothing changed against staging, or when the tree equals the last green run.
set -uo pipefail

input=$(cat)
[[ $(jq -r '.stop_hook_active // false' <<<"$input") == true ]] && exit 0
root=$(git -C "$(jq -r '.cwd // "."' <<<"$input")" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

base=$(git merge-base origin/staging HEAD 2>/dev/null) || exit 0
changed=$({
  git diff --name-only "$base"
  git ls-files --others --exclude-standard
} | sort -u)
[[ -z $changed ]] && exit 0

# The record `pnpm verify` keeps of the last green tree, shared with the pre-push hook
bash .github/scripts/verify-cache.sh check && exit 0

# A green `verify:brief` records the tree itself; `format` alone does not, so a push still runs the full verify
if grep -qvE '\.md$' <<<"$changed"; then script=verify:brief; else script=format; fi
if out=$(pnpm --silent "$script" 2>&1); then
  exit 0
fi
{
  echo "pnpm $script is red, fix it before finishing:"
  head -n 50 <<<"$out"
} >&2
exit 2
