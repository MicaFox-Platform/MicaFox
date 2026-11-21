#!/usr/bin/env bash
# Packs every public package under packages/ as npm would receive it and checks the tarball: what it ships, its packed
# package.json, then publint and Are the Types Wrong. Run by `pnpm test:pack` after `pnpm build`. Every failure says
# what is wrong and how to fix it.
set -uo pipefail

source_condition="@micafox/source"
status=0
# The tools of this repository, also when the script checks another workspace (its tests do)
bin="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/node_modules/.bin"

fail() {
  echo "✗ $1" >&2
  status=1
}

cd "$(git rev-parse --show-toplevel)" || exit 1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Workspace versions by package name, to check what `workspace:^` was packed as
versions=$(jq -s 'map({ (.name): .version }) | add' packages/*/package.json)

for dir in packages/*/; do
  dir=${dir%/}
  name=$(jq -r '.name' "$dir/package.json")
  # A private package is never published, such as the hub's (docs/architecture/hub/overview.md#packages)
  jq -e '.private == true' "$dir/package.json" >/dev/null && continue
  out="$tmp/${dir##*/}"
  mkdir -p "$out"

  if ! (cd "$dir" && pnpm pack --pack-destination "$out" >/dev/null 2>&1); then
    fail "$name: pnpm pack failed: run it in $dir to see why"
    continue
  fi
  tarball=$(find "$out" -name '*.tgz' | head -n 1)

  # The file list comes from the tarball itself: pnpm's own list leaves out the LICENSE it copies from the root
  files=$(tar -tzf "$tarball")
  for required in package.json README.md; do
    grep -qx "package/$required" <<<"$files" || fail "$name: the tarball has no $required: add it to $dir"
  done
  grep -qx "package/LICENSE" <<<"$files" ||
    fail "$name: pnpm pack did not copy the root LICENSE: check the pnpm version or add LICENSE to $dir"
  while IFS= read -r file; do
    [[ -n $file ]] && fail "$name: the tarball ships ${file#package/}: narrow \"files\" in $dir/package.json"
  done < <(grep -E '^package/(src|test)/|/__tests__/|\.test(-d)?\.[cm]?[jt]sx?$|\.tsbuildinfo$' <<<"$files")

  manifest=$(tar -xzOf "$tarball" package/package.json)

  # Users get the exports of the repo minus the source condition, which points at src/ that does not ship
  expected=$(jq -S --arg c "$source_condition" '.exports | del(.. | objects | .[$c]?)' "$dir/package.json")
  packed=$(jq -S '.exports' <<<"$manifest")
  [[ $expected == "$packed" ]] ||
    fail "$name: the packed exports differ from exports without \"$source_condition\": make publishConfig.exports in $dir/package.json match"
  jq -e '.publishConfig.exports == null' <<<"$manifest" >/dev/null ||
    fail "$name: publishConfig.exports was not applied by pnpm pack: check the pnpm version"

  # A workspace dependency ships as a range on the version in the repo
  while IFS=$'\t' read -r dep spec; do
    [[ -z $dep ]] && continue
    want=$(jq -r --arg d "$dep" '.[$d] // empty' <<<"$versions")
    got=$(jq -r --arg d "$dep" '.dependencies[$d] // .peerDependencies[$d] // empty' <<<"$manifest")
    case $spec in
      workspace:^) [[ $got == "^$want" ]] || fail "$name: $dep is packed as \"$got\", not \"^$want\"" ;;
      *) fail "$name: $dep is \"$spec\": use \"workspace:^\" so it ships as a caret range" ;;
    esac
  done < <(jq -r '(.dependencies // {}) + (.peerDependencies // {}) | to_entries[]
    | select(.value | startswith("workspace:")) | [.key, .value] | @tsv' "$dir/package.json")

  "$bin/publint" run --strict "$tarball" >"$out/publint.log" 2>&1 || {
    fail "$name: publint found problems:"
    cat "$out/publint.log" >&2
  }

  # A package with a require condition ships CommonJS too and must resolve for both; others ship ES modules only
  profile=esm-only
  jq -e '[.exports | .. | objects | has("require")] | any' <<<"$manifest" >/dev/null && profile=node16
  "$bin/attw" --profile "$profile" --no-emoji --no-color "$tarball" >"$out/attw.log" 2>&1 || {
    fail "$name: Are the Types Wrong found problems (profile $profile):"
    cat "$out/attw.log" >&2
  }
done

exit "$status"
