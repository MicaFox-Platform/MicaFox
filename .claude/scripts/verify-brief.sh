#!/usr/bin/env bash
# `pnpm verify` for AI agents: the same steps, read from the `verify` script so they cannot drift, but one line per
# green step and only the first and last lines of a failing one, so a red run does not flood the agent's context.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

head_lines=40
tail_lines=3

# Every part of `verify` must be `pnpm <script>`: anything else would be skipped, and a skipped step must not pass
verify=$(jq -er '.scripts.verify' package.json) || {
  echo "✗ cannot read the verify script from package.json" >&2
  exit 1
}
steps=()
while IFS= read -r part; do
  if [[ ! $part =~ ^[[:space:]]*pnpm[[:space:]]+([a-z][a-z:-]*)[[:space:]]*$ ]]; then
    echo "✗ verify part \"$part\" is not pnpm <script>: update .claude/scripts/verify-brief.sh" >&2
    exit 1
  fi
  steps+=("${BASH_REMATCH[1]}")
done < <(sed 's/&&/\n/g' <<<"$verify")
((${#steps[@]} > 0)) || {
  echo "✗ the verify script has no steps" >&2
  exit 1
}

for step in "${steps[@]}"; do
  if out=$(pnpm --silent "$step" 2>&1); then
    if [[ $step == test:coverage ]]; then
      echo "✓ $step: $(grep -E '^ +Tests ' <<<"$out" | xargs)"
      grep -E '^(Statements|Branches|Functions|Lines) +:' <<<"$out" | sed 's/^/  /'
    else
      echo "✓ $step"
    fi
    continue
  fi

  echo "✗ $step"
  lines=$(grep -vE '^[[:space:]]*$' <<<"$out")
  total=$(grep -c . <<<"$lines")
  if ((total <= head_lines + tail_lines)); then
    echo "$lines"
  else
    head -n "$head_lines" <<<"$lines"
    echo "… $((total - head_lines - tail_lines)) more lines; run pnpm $step for all of them"
    tail -n "$tail_lines" <<<"$lines"
  fi
  exit 1
done
