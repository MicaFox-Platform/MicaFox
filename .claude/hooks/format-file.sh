#!/usr/bin/env bash
# PostToolUse(Edit|Write): Prettier on the edited file, `eslint --fix` on .ts and .tsx; leftover errors go back to Claude.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // ""')
[[ -f $file ]] || exit 0
case $file in
  *.ts | *.tsx | *.css | *.js | *.mjs | *.cjs | *.json | *.md | *.yml | *.yaml) ;;
  *) exit 0 ;;
esac
root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
[[ -x $root/node_modules/.bin/prettier ]] || exit 0
cd "$root" || exit 0
rel=${file#"$root"/}
[[ $rel == node_modules/* || $rel == */node_modules/* ]] && exit 0

fail() {
  tail -n 20 <<<"$1" >&2
  exit 2
}
out=$(node_modules/.bin/prettier --write --ignore-unknown --log-level warn "$rel" 2>&1) || fail "$out"
if [[ $rel == *.ts || $rel == *.tsx ]]; then
  out=$(node_modules/.bin/eslint --fix --no-warn-ignored "$rel" 2>&1) || fail "$out"
fi
