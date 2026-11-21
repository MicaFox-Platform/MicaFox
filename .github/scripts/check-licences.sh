#!/usr/bin/env bash
# Checks licences by folder, since the top folder tells a package's licence (ADR 0039): the `license` field of every
# package under packages/ (MIT), hub/ (AGPL-3.0-only) and ee/ (its own terms), and the third-party production
# dependencies of what ships in the hub's image (ADR 0022): no GPL, AGPL or SSPL in hub/ and ee/, and only permissive
# licences in the MIT @micafox/ui. Both are lists of what passes, so a licence spelled in no SPDX form, or none, fails
# until a person reads it. Run by `pnpm lint` after `pnpm install`. Every failure says what is wrong and how to fix it.
set -uo pipefail

status=0
permissive='^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|CC0-1\.0|Unlicense|BlueOak-1\.0\.0|OFL-1\.1)$'
# Weak copyleft binds only the library itself, which the AGPL hub may combine with
weak_copyleft='^(LGPL-(2\.1|3\.0)(-only|-or-later)?|MPL-2\.0)$'

fail() {
  echo "✗ $1" >&2
  status=1
}

# A licence passes when one of its `OR` alternatives does; an `AND` or a missing licence never passes on its own
allows() {
  local license=$1 rule=$2 alternative
  [[ $license == *" AND "* ]] && return 1
  license=${license#(}
  license=${license%)}
  while IFS= read -r alternative; do
    case $rule in
      hub) [[ $alternative =~ $permissive || $alternative =~ $weak_copyleft ]] && return 0 ;;
      ui) [[ $alternative =~ $permissive ]] && return 0 ;;
    esac
  done <<<"${license// OR /$'\n'}"
  return 1
}

check() {
  local package=$1 rule=$2 out errors dependency license
  errors=$(mktemp)
  # Warnings on stderr must not mix into the answer
  if ! out=$(pnpm --filter "$package" licenses list --json --prod 2>"$errors"); then
    fail "$package: pnpm licenses list failed: run pnpm install, then pnpm --filter $package licenses list
$(cat "$errors")"
    rm -f "$errors"
    return
  fi
  rm -f "$errors"
  # pnpm prints this instead of JSON when the package has no third-party dependency
  [[ $out == "No licenses in packages found" ]] && return
  jq -e 'type == "object"' <<<"$out" >/dev/null 2>&1 || {
    fail "$package: pnpm licenses list printed no JSON object: check the pnpm version
$out"
    return
  }
  while IFS=$'\t' read -r dependency license; do
    allows "$license" "$rule" && continue
    case $rule in
      hub) fail "$package: $dependency is under ${license:-no licence}: the hub packages take only permissive licences, LGPL and MPL-2.0, never GPL, AGPL, SSPL or an unknown one (ADR 0022); pick another dependency" ;;
      ui) fail "$package: $dependency is under ${license:-no licence}: @micafox/ui is MIT and takes only permissive licences (ADR 0022); pick another dependency" ;;
    esac
  done < <(jq -r 'to_entries[] | .key as $key | .value[] | "\(.name)@\(.versions | join(","))\t\($key)"' <<<"$out")
}

cd "$(git rev-parse --show-toplevel)" || exit 1

# The `license` a package declares matches its folder; ee/ is proprietary, so never an open-source licence
declared() {
  local manifest=$1 folder=${1%%/*} license
  license=$(jq -r '.license // ""' "$manifest")
  case $folder in
    packages) [[ $license == MIT ]] && return ;;
    hub) [[ $license == AGPL-3.0-only ]] && return ;;
    ee) [[ $license == UNLICENSED || $license == "SEE LICENSE IN "* ]] && return ;;
  esac
  case $folder in
    packages) fail "$manifest: license is \"$license\": everything under packages/ is MIT (ADR 0039); set \"license\": \"MIT\" or move the package" ;;
    hub) fail "$manifest: license is \"$license\": everything under hub/ is AGPL-3.0-only (ADR 0039); set \"license\": \"AGPL-3.0-only\" or move the package" ;;
    ee) fail "$manifest: license is \"$license\": ee/ is under its own terms (ADR 0039); set \"license\": \"SEE LICENSE IN <file>\" or \"UNLICENSED\"" ;;
  esac
}

shopt -s nullglob
for manifest in packages/*/package.json hub/*/package.json ee/*/package.json; do
  declared "$manifest"
done

check @micafox/ui ui
# Every feature is a hub/<feature> and the extension lives in ee/, so a new one is checked without a change here;
# pnpm lists no dependency of a workspace dependency, hence each package on its own
for manifest in hub/*/package.json ee/*/package.json; do
  check "$(jq -r '.name' "$manifest")" hub
done

((status == 0)) && echo "✓ licences"
exit "$status"
