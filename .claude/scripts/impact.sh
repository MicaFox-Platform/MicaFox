#!/usr/bin/env bash
# Deterministic blast-radius facts for the `impact` agent: what changed against staging and what depends on it.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

# Optional base: the commit the last review saw, so a rework is assessed on its own delta
base=${1:-$(git merge-base origin/staging HEAD)}
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
  echo "unknown base commit: $base" >&2
  exit 1
}
changed=$({
  git diff --name-only "$base"
  git ls-files --others --exclude-standard
} | sort -u)
sources=$(grep -E '^(packages|tools)/[^/]+/src/.*\.ts$' <<<"$changed" | grep -vE '/__tests__/|\.(test|test-d|d)\.ts$')

section() {
  echo "$1:"
  if [[ -n $2 ]]; then sed 's/^/  /' <<<"$2"; else echo "  none"; fi
}

json_field_changed() {
  [[ $(git show "$base:$1" 2>/dev/null | jq -S ".$2") != $(jq -S ".$2" "$1") ]]
}

sensitive=$(
  grep -E '^packages/[^/]+/src/index\.ts$' <<<"$changed" | sed 's/^/public API: /'
  grep -qE '^packages/protocol/' <<<"$changed" && echo "protocol: packages/protocol"
  grep -qE '^packages/sdk/src/connector/' <<<"$changed" && echo "transport: packages/sdk/src/connector"
  for manifest in $(grep -E '^(packages|tools)/[^/]+/package\.json$' <<<"$changed"); do
    if ! git cat-file -e "$base:$manifest" 2>/dev/null; then
      echo "new package: $manifest"
      continue
    fi
    json_field_changed "$manifest" exports && echo "public API: $manifest exports"
    json_field_changed "$manifest" dependencies && echo "dependencies: $manifest"
    json_field_changed "$manifest" peerDependencies && echo "peer dependencies: $manifest"
  done
)

importers=$(for file in $sources; do
  name=$(basename "$file" .ts)
  grep -rlE "from ['\"]\.{1,2}/([^'\"]*/)?$name\.js['\"]" packages/*/src examples/*/src examples/*/tests tools/*/src 2>/dev/null |
    grep -vxF "$file" | sed "s|^|$file ← |"
done)

# Tests live in the module folder's __tests__/: foo.ts → foo.test.ts, foo.test-d.ts or foo-<behavior>.test.ts;
# index.ts may also be tested under its folder's name (hub-connector/index.ts → hub-connector-*.test.ts)
has_test() {
  compgen -G "$1/__tests__/$2.test.ts" >/dev/null || compgen -G "$1/__tests__/$2.test-d.ts" >/dev/null ||
    compgen -G "$1/__tests__/$2-*.test.ts" >/dev/null
}
untested=$(for file in $sources; do
  dir=$(dirname "$file")
  name=$(basename "$file" .ts)
  has_test "$dir" "$name" && continue
  [[ $name == index ]] && has_test "$dir" "$(basename "$dir")" && continue
  echo "$file"
done)

if [[ -n ${1:-} ]]; then origin="given"; else origin="merge-base with origin/staging"; fi
echo "base: $(git rev-parse --short "$base") ($origin)"
section "changed files" "$changed"
section "affected packages (changed and their dependents)" \
  "$(pnpm --silent ls -r --depth -1 --filter "...[$base]" --json 2>/dev/null | jq -r '.[].name')"
section "sensitive areas" "$sensitive"
section "importers of changed source files" "$importers"
section "changed source files with no test named after them (may be tested through another module)" "$untested"
section "docs changed" "$(grep -E '^docs/' <<<"$changed")"
