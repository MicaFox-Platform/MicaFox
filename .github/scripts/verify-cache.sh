#!/usr/bin/env bash
# Remembers the working tree of the last green `pnpm verify`, so the hooks that require a green verify (pre-push and
# the Claude Code Stop hook) do not run it again on the same tree. The key covers the Node version, HEAD, every change
# against HEAD and the content of untracked files: any edit, commit or other Node version means a full run.
#
#   begin  first step of `pnpm verify`: notes the key of the tree it is about to check
#   mark   last step, reached only when every step passed: records that key as green, unless the tree changed since
#   check  exits 0 when the current tree is the last green one
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

cache=node_modules/.cache/micafox
pending=$cache/verify-pending
green=$cache/verify-green

tree_key() {
  {
    node --version
    git rev-parse HEAD
    git diff HEAD --binary
    git ls-files --others --exclude-standard -z | xargs -0 shasum 2>/dev/null
  } | shasum -a 256 | cut -d' ' -f1
}

case ${1:-} in
begin)
  mkdir -p "$cache" && tree_key >"$pending"
  ;;
mark)
  # A tree edited during the run was not the one checked: leave it to the next run
  if [[ -f $pending && $(cat "$pending") == "$(tree_key)" ]]; then
    mv "$pending" "$green"
  else
    rm -f "$pending"
    echo "the tree changed during pnpm verify: not recorded as green" >&2
  fi
  ;;
check)
  [[ -f $green && $(cat "$green") == "$(tree_key)" ]]
  ;;
*)
  echo "usage: verify-cache.sh begin | mark | check" >&2
  exit 2
  ;;
esac
