#!/usr/bin/env bash
# Sets SDK_VERSION in packages/sdk/src/connector/session/version.ts to the version in packages/sdk/package.json.
# `pnpm version-packages` runs it after `changeset version`: the constant cannot read package.json at runtime (see the
# file), and version.test.ts fails while the two differ.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
file=packages/sdk/src/connector/session/version.ts

version=$(node -p 'require("./packages/sdk/package.json").version') || exit 1
# A temporary file instead of `sed -i`, whose syntax differs between GNU and BSD sed
sed -E "s/^(export const SDK_VERSION = \")[^\"]*(\";)\$/\1$version\2/" "$file" >"$file.tmp" && mv "$file.tmp" "$file"
grep -q "^export const SDK_VERSION = \"$version\";\$" "$file" || {
  echo "✗ no line export const SDK_VERSION = \"…\"; in $file to set to $version" >&2
  exit 1
}
echo "✓ SDK_VERSION $version"
