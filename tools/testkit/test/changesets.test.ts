// The release scripts in .github/scripts: the changeset checks CI runs on every pull request, and the SDK_VERSION sync
// of `pnpm version-packages`. Each test builds a throwaway git repository with the real .changeset/config.json, a
// public 0.x package, a public 1.x package and a private one, and runs the script in it as CI does.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS } from "../src/processes.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "check-changesets.sh");
const SYNC_SCRIPT = path.join(ROOT, ".github", "scripts", "sync-sdk-version.sh");
const VERSION_FILE = "packages/sdk/src/connector/session/version.ts";
// The developer's git config may sign commits or lack an identity; the fixture repository must not depend on it
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries([
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_AUTHOR_NAME", "Test"],
    ["GIT_AUTHOR_EMAIL", "test@example.com"],
    ["GIT_COMMITTER_NAME", "Test"],
    ["GIT_COMMITTER_EMAIL", "test@example.com"],
  ]),
};
const EMPTY_CHANGESET = "---\n---\n";

let repo: string;

const write = (file: string, content: string): void => {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const git = (...args: string[]): void => {
  const result = spawnSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
};

const commit = (message: string): void => {
  git("add", "--all");
  git("commit", "--quiet", "--message", message);
};

const packageJson = (name: string, version: string, isPrivate = false): string =>
  JSON.stringify({ name, version, ...(isPrivate ? { private: true } : {}) });

const changeset = (bumps: Record<string, "major" | "minor" | "patch">): string =>
  `---\n${Object.entries(bumps)
    .map(([name, bump]) => `"${name}": ${bump}`)
    .join("\n")}\n---\n\nA change for users.\n`;

const run = (...args: string[]): SpawnSyncReturns<string> =>
  spawnSync("bash", [SCRIPT, ...args], { cwd: repo, env: GIT_ENV, encoding: "utf8" });

/** Commits the base on `staging` and switches to a feature branch, as a pull request into staging sees it. */
const createRepo = (): void => {
  repo = mkdtempSync(path.join(tmpdir(), "micafox-changesets-"));
  git("init", "--quiet", "--initial-branch", "staging");
  write("package.json", packageJson("fixture", "0.0.0", true));
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  mkdirSync(path.join(repo, ".changeset"));
  copyFileSync(path.join(ROOT, ".changeset", "config.json"), path.join(repo, ".changeset", "config.json"));
  copyFileSync(path.join(ROOT, ".changeset", "README.md"), path.join(repo, ".changeset", "README.md"));
  write("packages/young/package.json", packageJson("@fixture/young", "0.3.0"));
  write("packages/young/src/index.ts", "export const a = 1;\n");
  write("packages/stable/package.json", packageJson("@fixture/stable", "1.2.0"));
  write("packages/stable/src/index.ts", "export const b = 1;\n");
  write("packages/hidden/package.json", packageJson("@fixture/hidden", "0.1.0", true));
  write("packages/hidden/src/index.ts", "export const c = 1;\n");
  commit("chore: base");
  git("switch", "--quiet", "--create", "feat/change");
};

beforeEach(createRepo);
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check-changesets.sh pr", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  it("fails when a shipped file of a public package changed without a changeset", () => {
    write("packages/young/src/index.ts", "export const a = 2;\n");
    commit("feat: change young");

    const result = run("pr", "staging");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ a public package changed since staging without a changeset");
    expect(result.stderr).toContain("pnpm changeset --empty");
  });

  it("passes when the pull request adds a changeset for the package", () => {
    write("packages/young/src/index.ts", "export const a = 2;\n");
    write(".changeset/young-change.md", changeset({ "@fixture/young": "minor" }));
    commit("feat: change young");

    const result = run("pr", "staging");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ changesets");
  });

  it("passes with an empty changeset, written by pnpm changeset --empty", () => {
    write("packages/stable/package.json", packageJson("@fixture/stable", "1.2.0").replace("}", ',"scripts":{}}'));
    write(".changeset/no-release.md", EMPTY_CHANGESET);
    commit("build: change a script");

    expect(run("pr", "staging").status).toBe(0);
  });

  it("checks also changes not yet committed, so it runs locally before a commit", () => {
    write("packages/young/src/index.ts", "export const a = 2;\n");

    expect(run("pr", "staging").status).toBe(1);
  });

  it("fails on untracked files, which git diff and so changeset status do not see", () => {
    write("packages/young/src/index.ts", "export const a = 2;\n");
    git("add", "--all");
    write(".changeset/young-change.md", changeset({ "@fixture/young": "minor" }));

    const result = run("pr", "staging");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "untracked files are not checked, git add them first:\n  .changeset/young-change.md",
    );
  });

  it("does not blame a missing changeset when changeset status fails for another reason", () => {
    write("packages/young/src/index.ts", "export const a = 2;\n");
    write(".changeset/unknown.md", changeset({ "@fixture/missing": "minor" }));
    commit("feat: change young");

    const result = run("pr", "staging");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ changeset status failed: see above");
  });

  it.each([
    ["a unit test of a public package", "packages/young/src/__tests__/index.test.ts"],
    ["a file outside what the package ships", "packages/young/test/e2e.test.ts"],
    ["a private package", "packages/hidden/src/index.ts"],
    ["a file outside the packages", "docs/notes.md"],
  ])("needs no changeset for %s", (_, file) => {
    write(file, "export const changed = true;\n");
    commit("test: change a file that does not ship");

    expect(run("pr", "staging").status).toBe(0);
  });

  it("fails on a major changeset for a 0.x package and names the file", () => {
    write("packages/young/src/index.ts", "export const a = 2;\n");
    write(".changeset/breaking.md", changeset({ "@fixture/young": "major" }));
    commit("feat!: break young");

    const result = run("pr", "staging");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("major changeset for a 0.x package");
    expect(result.stderr).toContain(".changeset/breaking.md: @fixture/young is 0.3.0");
  });

  it("lists only the 0.x packages of a changeset that is major for several", () => {
    write("packages/young/src/index.ts", "export const a = 2;\n");
    write("packages/stable/src/index.ts", "export const b = 2;\n");
    write(".changeset/breaking.md", changeset({ "@fixture/young": "major", "@fixture/stable": "major" }));
    commit("feat!: break both");

    const result = run("pr", "staging");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@fixture/young is 0.3.0");
    expect(result.stderr).not.toContain("@fixture/stable");
  });

  it("fails on an unknown base and says so instead of blaming a missing changeset", () => {
    const result = run("pr", "origin/staging");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown base origin/staging");
    expect(result.stderr).not.toContain("without a changeset");
  });

  it("passes a major changeset for a package at 1.0 or later", () => {
    write("packages/stable/src/index.ts", "export const b = 2;\n");
    write(".changeset/breaking.md", changeset({ "@fixture/stable": "major" }));
    commit("feat!: break stable");

    expect(run("pr", "staging").status).toBe(0);
  });
});

describe("check-changesets.sh release", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  it("fails while a changeset that names a package is left, and says to merge the version PR", () => {
    write(".changeset/young-change.md", changeset({ "@fixture/young": "minor" }));

    const result = run("release");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changesets left: .changeset/young-change.md");
    expect(result.stderr).toContain("chore(release): version packages");
  });

  it("passes with only the README and empty changesets, which the version PR never applies", () => {
    write(".changeset/no-release.md", EMPTY_CHANGESET);

    const result = run("release");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ no changeset left");
  });
});

describe("sync-sdk-version.sh", () => {
  it("sets SDK_VERSION to the version that changeset version wrote to the SDK's package.json", () => {
    write("packages/sdk/package.json", packageJson("@micafox/sdk", "0.2.0"));
    write(VERSION_FILE, '// The constant\nexport const SDK_VERSION = "0.1.0";\n');

    const result = spawnSync("bash", [SYNC_SCRIPT], { cwd: repo, env: GIT_ENV, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(readFileSync(path.join(repo, VERSION_FILE), "utf8")).toBe(
      '// The constant\nexport const SDK_VERSION = "0.2.0";\n',
    );
  });

  it("fails when version.ts no longer declares the constant on one line", () => {
    write("packages/sdk/package.json", packageJson("@micafox/sdk", "0.2.0"));
    write(VERSION_FILE, 'export const SDK_VERSION =\n  "0.1.0";\n');

    const result = spawnSync("bash", [SYNC_SCRIPT], { cwd: repo, env: GIT_ENV, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no line export const SDK_VERSION");
  });
});

describe("check-changesets.sh", () => {
  it("prints the usage on an unknown command", () => {
    const result = run("publish");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: check-changesets.sh pr [<base>] | release");
  });
});
