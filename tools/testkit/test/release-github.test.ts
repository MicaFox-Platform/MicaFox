// The tags and GitHub Releases of .github/scripts/release-github.sh (the release workflow): each test builds a throwaway
// repository with public and private packages, stands in for `npm` and `gh` with scripts that keep their state in
// files, and runs the script in it as CI does.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "release-github.sh");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
// The developer's git config must not matter: the script only needs the repository's root
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries([
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
  ]),
};
// A commit needs an author, which the cleared git config no longer gives
const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...GIT_ENV,
  ...Object.fromEntries([
    ["GIT_AUTHOR_NAME", "Fixture"],
    ["GIT_AUTHOR_EMAIL", "fixture@example.com"],
    ["GIT_COMMITTER_NAME", "Fixture"],
    ["GIT_COMMITTER_EMAIL", "fixture@example.com"],
  ]),
};

// `npm view <name@version> version`: prints the version when the spec is listed in $STATE/npm, else fails like npm
const NPM_STUB = `#!/usr/bin/env bash
if [[ -e "$STATE/npm-down" ]]; then
  echo "npm error network request failed" >&2
  exit 1
fi
if grep -qxF "$2" "$STATE/npm"; then
  echo "\${2##*@}"
else
  echo "npm error code E404" >&2
  exit 1
fi
`;

// `gh release view|create <tag>`: the Releases live in $STATE/releases; every call is logged to $STATE/calls
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STATE/calls"
tag=$3
case "$1 $2" in
  "release view")
    if [[ -e "$STATE/gh-down" ]]; then
      echo "error connecting to api.github.com" >&2
      exit 1
    fi
    if grep -qxF "$tag" "$STATE/releases"; then
      echo "title: $tag"
    else
      echo "release not found" >&2
      exit 1
    fi
    ;;
  "release create")
    if [[ -e "$STATE/gh-denied" ]]; then
      echo "HTTP 403: Resource not accessible by integration" >&2
      exit 1
    fi
    echo "$tag" >> "$STATE/releases"
    while [[ $# -gt 0 ]]; do
      [[ $1 == --notes-file ]] && cp "$2" "$STATE/notes-\${tag//\\//_}"
      shift
    done
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 2
    ;;
esac
`;

let repo: string;
let state: string;

const write = (file: string, content: string): void => {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const writeStub = (name: string, content: string): void => {
  const target = path.join(state, "bin", name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  chmodSync(target, 0o755);
};

const writePackage = (directory: string, manifest: Record<string, unknown>, changelog?: string): void => {
  write(`packages/${directory}/package.json`, JSON.stringify(manifest));
  if (changelog !== undefined) {
    write(`packages/${directory}/CHANGELOG.md`, changelog);
  }
};

const CHANGELOG = `# @fixture/core

## 0.2.0

### Minor Changes

- abc1234: Add the second thing

## 0.1.0

### Minor Changes

- def5678: Initial release
`;

const setState = (file: string, lines: readonly string[]): void => {
  writeFileSync(path.join(state, file), lines.map((line) => `${line}\n`).join(""));
};

const lines = (file: string): string[] => {
  const target = path.join(state, file);
  return existsSync(target) ? readFileSync(target, "utf8").split("\n").filter(Boolean) : [];
};

const createRepository = (): void => {
  repo = mkdtempSync(path.join(tmpdir(), "micafox-release-"));
  state = mkdtempSync(path.join(tmpdir(), "micafox-release-state-"));
  spawnSync("git", ["init", "--quiet"], { cwd: repo, env: GIT_ENV });
  writeStub("npm", NPM_STUB);
  writeStub("gh", GH_STUB);
  setState("npm", ["@fixture/core@0.2.0"]);
  setState("releases", []);
  writePackage("core", { name: "@fixture/core", version: "0.2.0" }, CHANGELOG);
  writePackage("hub", { name: "@fixture/hub", version: "1.0.0", private: true });
};

const run = (): SpawnSyncReturns<string> =>
  spawnSync("bash", [SCRIPT], {
    cwd: repo,
    env: {
      ...GIT_ENV,
      ...Object.fromEntries([
        ["PATH", [path.join(state, "bin"), process.env.PATH].join(path.delimiter)],
        ["STATE", state],
        ["GITHUB_SHA", COMMIT],
      ]),
    },
    encoding: "utf8",
  });

beforeEach(createRepository);
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe("release-github.sh", () => {
  it("creates the tag and the Release of a published version on the workflow's commit", () => {
    const result = run();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ @fixture/core@0.2.0: tag and Release created");
    expect(lines("calls").join("\n")).toContain(
      `release create @fixture/core@0.2.0 --target ${COMMIT} --title @fixture/core@0.2.0 --notes-file`,
    );
  });

  it("puts only the changelog section of that version in the Release", () => {
    run();

    const notes = readFileSync(path.join(state, "notes-@fixture_core@0.2.0"), "utf8");
    expect(notes).toContain("abc1234: Add the second thing");
    expect(notes).not.toContain("Initial release");
    expect(notes).not.toContain("## 0.2.0");
  });

  it("creates no duplicate when the Release exists", () => {
    setState("releases", ["@fixture/core@0.2.0"]);

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("@fixture/core@0.2.0: has its Release, skipped");
    expect(lines("calls").filter((call) => call.startsWith("release create"))).toEqual([]);
  });

  it("creates nothing the second time it runs", () => {
    run();
    const second = run();

    expect(second.status).toBe(0);
    expect(lines("releases")).toEqual(["@fixture/core@0.2.0"]);
  });

  it("skips a version that is not on npm", () => {
    setState("npm", []);

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("@fixture/core@0.2.0: not on npm, skipped");
    expect(lines("calls")).toEqual([]);
  });

  it("releases a version this run published before npm lists it", () => {
    setState("npm", []);
    spawnSync("git", ["commit", "--quiet", "--allow-empty", "--message", "release"], { cwd: repo, env: COMMIT_ENV });
    spawnSync("git", ["tag", "@fixture/core@0.2.0"], { cwd: repo, env: GIT_ENV });

    const result = run();

    expect(result.status).toBe(0);
    expect(lines("releases")).toEqual(["@fixture/core@0.2.0"]);
  });

  it("ignores private packages", () => {
    setState("npm", ["@fixture/core@0.2.0", "@fixture/hub@1.0.0"]);

    run();

    expect(lines("releases")).toEqual(["@fixture/core@0.2.0"]);
  });

  it("releases every published package and leaves the unpublished one", () => {
    writePackage("extra", { name: "@fixture/extra", version: "3.0.0" }, "# @fixture/extra\n\n## 3.0.0\n\n- A\n");
    writePackage("late", { name: "@fixture/late", version: "4.0.0" }, "# @fixture/late\n\n## 4.0.0\n\n- B\n");
    setState("npm", ["@fixture/core@0.2.0", "@fixture/extra@3.0.0"]);

    const result = run();

    expect(result.status).toBe(0);
    expect(lines("releases")).toEqual(["@fixture/core@0.2.0", "@fixture/extra@3.0.0"]);
  });

  it("fails when the changelog has no section of the version, and still releases the others", () => {
    writePackage("extra", { name: "@fixture/extra", version: "3.0.0" }, "# @fixture/extra\n\n## 2.0.0\n\n- A\n");
    setState("npm", ["@fixture/core@0.2.0", "@fixture/extra@3.0.0"]);

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✗ @fixture/extra@3.0.0: packages/extra/CHANGELOG.md has no "## 3.0.0" section');
    expect(lines("releases")).toEqual(["@fixture/core@0.2.0"]);
  });

  it("fails when npm cannot be asked, instead of reading it as not published", () => {
    writeFileSync(path.join(state, "npm-down"), "");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @fixture/core@0.2.0: could not ask npm whether it is published");
    expect(lines("releases")).toEqual([]);
  });

  it("fails when GitHub cannot be asked, instead of reading it as no Release", () => {
    writeFileSync(path.join(state, "gh-down"), "");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @fixture/core@0.2.0: could not ask GitHub whether it has a Release");
    expect(lines("releases")).toEqual([]);
  });

  it("fails when GitHub refuses the Release", () => {
    writeFileSync(path.join(state, "gh-denied"), "");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @fixture/core@0.2.0: gh release create failed");
  });
});
