// The record of the last green `pnpm verify` kept by .github/scripts/verify-cache.sh, which the pre-push hook and the
// Claude Code Stop hook read to skip a second run of the same tree. Each test runs the script in a throwaway git
// repository with one commit, its node_modules/ ignored as in this repository.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "verify-cache.sh");
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

let repo: string;

const write = (file: string, content: string): void => {
  writeFileSync(path.join(repo, file), content);
};

const git = (...args: string[]): void => {
  const result = spawnSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
};

const run = (command: string, env: NodeJS.ProcessEnv = GIT_ENV): SpawnSyncReturns<string> =>
  spawnSync("bash", [SCRIPT, command], { cwd: repo, env, encoding: "utf8" });

/** begin and mark, as a green `pnpm verify` runs them around its steps. */
const passVerify = (): void => {
  run("begin");
  run("mark");
};

// A `node` first on the PATH that reports another version, as after switching Node
const withOtherNode = (): NodeJS.ProcessEnv => {
  const bin = path.join(repo, "other-node");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "node"), "#!/usr/bin/env bash\necho v99.0.0\n");
  chmodSync(path.join(bin, "node"), 0o755);
  return { ...GIT_ENV, ...Object.fromEntries([["PATH", `${bin}:${process.env.PATH ?? ""}`]]) };
};

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "micafox-verify-cache-"));
  git("init", "--quiet");
  write(".gitignore", "node_modules/\nother-node/\n");
  write("index.ts", "export const a = 1;\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "chore: start");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("verify-cache.sh check", () => {
  it("fails before any green run", () => {
    const result = run("check");

    expect(result.status).toBe(1);
  });

  it("passes on the tree of the last green run", () => {
    passVerify();

    const result = run("check");

    expect(result.status).toBe(0);
  });

  it("fails once a tracked file changed after the green run", () => {
    passVerify();
    write("index.ts", "export const a = 2;\n");

    const result = run("check");

    expect(result.status).toBe(1);
  });

  it("fails once an untracked file was added after the green run", () => {
    passVerify();
    write("new.ts", "export const b = 1;\n");

    const result = run("check");

    expect(result.status).toBe(1);
  });

  it("fails once the same change was committed after the green run", () => {
    write("index.ts", "export const a = 2;\n");
    passVerify();
    git("commit", "--quiet", "--all", "--message", "chore: change");

    const result = run("check");

    expect(result.status).toBe(1);
  });

  it("fails under another Node version than the green run", () => {
    passVerify();

    const result = run("check", withOtherNode());

    expect(result.status).toBe(1);
  });
});

describe("verify-cache.sh mark", () => {
  it("records nothing when the tree changed during the run, and says so", () => {
    run("begin");
    write("index.ts", "export const a = 2;\n");

    const marked = run("mark");

    expect({ stderr: marked.stderr.trim(), check: run("check").status }).toEqual({
      stderr: "the tree changed during pnpm verify: not recorded as green",
      check: 1,
    });
  });
});

describe("verify-cache.sh", () => {
  it("exits 2 with the usage on an unknown command", () => {
    const result = run("clear");

    expect({ status: result.status, stderr: result.stderr.trim() }).toEqual({
      status: 2,
      stderr: "usage: verify-cache.sh begin | mark | check",
    });
  });
});
