#!/usr/bin/env bash
# Checks the folder rules of .claude/rules/code-quality.md#structure that ESLint cannot: run by `pnpm lint`.
# Every failure says what is wrong and how to fix it.
set -uo pipefail

max_sources=10
max_module_tests=3
status=0

fail() {
  echo "✗ $1" >&2
  status=1
}

cd "$(git rev-parse --show-toplevel)" || exit 1

while IFS= read -r dir; do
  if [[ -z $(ls -A "$dir") ]]; then
    fail "$dir is empty: delete it"
    continue
  fi

  sources=$(find "$dir" -maxdepth 1 -type f -name '*.ts' ! -name '*.test.ts' ! -name '*.test-d.ts' | sort)
  count=$(grep -c . <<<"$sources")
  ((count > max_sources)) &&
    fail "$dir has $count source files, at most $max_sources: group them into sub-component folders with an index.ts"

  while IFS= read -r source; do
    [[ -z $source ]] && continue
    module=$(basename "$source" .ts)
    tests=$(find "$dir" -maxdepth 1 -type f \( -name "$module.test.ts" -o -name "$module-*.test.ts" \
      -o -name "$module.test-d.ts" -o -name "$module-*.test-d.ts" \) | grep -c .)
    ((tests > max_module_tests)) &&
      fail "$source has $tests test files, at most $max_module_tests: move it and its tests into a folder $module/"
  done <<<"$sources"
done < <(find packages/*/src packages/*/test examples/*/src -type d 2>/dev/null)

((status == 0)) && echo "✓ folder structure"
exit "$status"
