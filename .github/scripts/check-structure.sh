#!/usr/bin/env bash
# Checks the folder rules of .claude/rules/code-quality.md#structure and .claude/rules/testing.md#where-tests-live
# that ESLint cannot: run by `pnpm lint`. Every failure says what is wrong and how to fix it.
set -uo pipefail

max_sources=8
status=0

fail() {
  echo "✗ $1" >&2
  status=1
}

is_test() {
  [[ $1 == *.test.ts || $1 == *.test-d.ts ]]
}

cd "$(git rev-parse --show-toplevel)" || exit 1

while IFS= read -r dir; do
  if [[ -z $(ls -A "$dir") ]]; then
    fail "$dir is empty: delete it"
    continue
  fi

  sources=$(find "$dir" -maxdepth 1 -type f -name '*.ts' ! -name '*.test.ts' ! -name '*.test-d.ts' | grep -c .)
  ((sources > max_sources)) &&
    fail "$dir has $sources source files, at most $max_sources: group them into sub-component folders with an index.ts"
# Next.js writes its build to .next/ beside its sources; it is not ours to structure
done < <(find packages/*/src packages/*/test examples/*/src tools/*/src -type d -not -path '*/.next' -not -path '*/.next/*' 2>/dev/null)

# In src/, tests live only in __tests__/, which holds nothing else
while IFS= read -r file; do
  in_tests_folder=$([[ $(basename "$(dirname "$file")") == __tests__ ]] && echo yes)
  if is_test "$file" && [[ -z $in_tests_folder ]]; then
    fail "$file is a test outside __tests__/: move it to $(dirname "$file")/__tests__/"
  elif ! is_test "$file" && [[ -n $in_tests_folder ]]; then
    fail "$file is not a test: __tests__/ holds only *.test.ts and *.test-d.ts; move it out"
  fi
done < <(find packages/*/src examples/*/src tools/*/src -type f -not -path '*/.next/*' 2>/dev/null)

while IFS= read -r dir; do
  fail "$dir is a folder inside __tests__/: tests of a sub-component go to its own __tests__/"
done < <(find packages/*/src examples/*/src tools/*/src -type d -path '*/__tests__/*' 2>/dev/null)

((status == 0)) && echo "✓ folder structure"
exit "$status"
