// The commit signature checks of .github/scripts/check-signatures.sh (CI and the pre-push hook): `pr` runs against a
// stand-in for `gh api` that applies the script's own jq filter to a fixture of GitHub's commit list; `commits` runs
// in a throwaway repository with real SSH-signed and unsigned commits.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "check-signatures.sh");
const HOW_TO = "docs/development.md#signing-commits";

// `gh api --paginate <path> --jq <filter>`: runs the filter over $STATE/commits.json, logs the call to $STATE/calls;
// $STATE/gh-notice stands for a notice gh prints on stderr next to a good answer
const GH_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STATE/calls"
[[ -e "$STATE/gh-notice" ]] && echo "A new release of gh is available" >&2
if [[ -e "$STATE/gh-denied" ]]; then
  echo "HTTP 403: Resource not accessible by integration" >&2
  exit 1
fi
while [[ $# -gt 0 ]]; do
  [[ $1 == --jq ]] && jq -r "$2" "$STATE/commits.json" && exit
  shift
done
echo "no --jq given" >&2
exit 2
`;

interface Commit {
  readonly sha: string;
  readonly commit: {
    readonly message: string;
    readonly verification: { readonly verified: boolean; readonly reason: string };
  };
}

// GitHub verifies a commit exactly when its reason is "valid"
const commit = (sha: string, message: string, reason: string): Commit => ({
  sha,
  commit: { message, verification: { verified: reason === "valid", reason } },
});

let dir: string;
let state: string;

const setCommits = (commits: readonly Commit[]): void => {
  writeFileSync(path.join(state, "commits.json"), JSON.stringify(commits));
};

const runPr = (extraEnv: ReadonlyArray<readonly [string, string]> = []): SpawnSyncReturns<string> =>
  spawnSync("bash", [SCRIPT, "pr", "MicaFox-Platform/MicaFox", "42"], {
    cwd: dir,
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["PATH", [path.join(state, "bin"), process.env.PATH].join(path.delimiter)],
        ["STATE", state],
        ...extraEnv,
      ]),
    },
    encoding: "utf8",
  });

// A repository of its own, with no global config: only the SSH signing settings below decide what is signed
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries([
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_AUTHOR_NAME", "Fixture"],
    ["GIT_AUTHOR_EMAIL", "fixture@example.com"],
    ["GIT_COMMITTER_NAME", "Fixture"],
    ["GIT_COMMITTER_EMAIL", "fixture@example.com"],
  ]),
};

const git = (...args: string[]): string => {
  const result = spawnSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  return result.stdout.trim();
};

const commitFile = (subject: string, signed: boolean): string => {
  writeFileSync(path.join(dir, `${subject}.txt`), subject);
  git("add", ".");
  git("-c", `commit.gpgsign=${String(signed)}`, "commit", "--quiet", "-m", subject);
  return git("rev-parse", "HEAD");
};

const runCommits = (...range: string[]): SpawnSyncReturns<string> =>
  spawnSync("bash", [SCRIPT, "commits", ...range], { cwd: dir, env: GIT_ENV, encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "micafox-signatures-"));
  state = mkdtempSync(path.join(tmpdir(), "micafox-signatures-state-"));
  mkdirSync(path.join(state, "bin"));
  writeFileSync(path.join(state, "bin", "gh"), GH_STUB);
  chmodSync(path.join(state, "bin", "gh"), 0o755);
  git("init", "--quiet");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe("check-signatures.sh pr", () => {
  it("passes when GitHub verifies every commit, bots included", () => {
    setCommits([
      commit("a1b2c3d4e5f6", "feat: add snapshots", "valid"),
      commit("b2c3d4e5f6a1", "chore(deps): bump vitest", "valid"),
    ]);

    const result = runPr();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ commit signatures");
  });

  it("lists each unverified commit with its reason and the how-to, and passes the verified ones over", () => {
    setCommits([
      commit("a1b2c3d4e5f6", "feat: add snapshots\n\nlong body", "valid"),
      commit("b2c3d4e5f6a1", "fix: close the socket", "no_user"),
      commit("c3d4e5f6a1b2", "docs: explain signing", "unsigned"),
    ]);

    const result = runPr();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ b2c3d4e fix: close the socket (no_user)");
    expect(result.stderr).toContain("✗ c3d4e5f docs: explain signing (unsigned)");
    expect(result.stderr).not.toContain("a1b2c3d");
    expect(result.stderr).toContain(HOW_TO);
  });

  it("says what to do for the reason of each unverified commit", () => {
    setCommits([
      commit("a1b2c3d4e5f6", "feat: one", "no_user"),
      commit("b2c3d4e5f6a1", "feat: two", "unknown_key"),
      commit("c3d4e5f6a1b2", "feat: three", "unsigned"),
      commit("d4e5f6a1b2c3", "feat: four", "bad_email"),
    ]);

    const result = runPr();

    expect(result.stderr).toContain("the commit email is on no GitHub account");
    expect(result.stderr).toContain("not on the author's GitHub account as a Signing key");
    expect(result.stderr).toContain("not signed: sign it");
    expect(result.stderr).toContain("the commit email is not one of the signing key's emails");
  });

  it("passes when gh prints a notice on stderr next to a good answer", () => {
    setCommits([commit("a1b2c3d4e5f6", "feat: add snapshots", "valid")]);
    writeFileSync(path.join(state, "gh-notice"), "");

    const result = runPr();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("strips control characters from a subject, so a fork cannot start a workflow command", () => {
    setCommits([commit("a1b2c3d4e5f6", "fix: x\r::stop-commands::token", "unsigned")]);

    const result = runPr();

    expect(result.stderr).toContain("✗ a1b2c3d fix: x ::stop-commands::token (unsigned)");
    expect(result.stderr).not.toContain("\r");
  });

  it("warns that GitHub lists no more than 250 commits of a pull request", () => {
    setCommits(
      Array.from({ length: 250 }, (_, index) => commit(`${String(index).padStart(7, "0")}abc`, "feat: x", "valid")),
    );

    const result = runPr();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("only the first 250 commits were checked");
  });

  it("fails instead of passing when GitHub cannot be read", () => {
    setCommits([]);
    writeFileSync(path.join(state, "gh-denied"), "");

    const result = runPr();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not read the commits of MicaFox-Platform/MicaFox#42");
    expect(result.stdout).not.toContain("✓");
  });

  it("reads every page of the pull request's commits, 100 at a time", () => {
    setCommits([]);

    runPr();

    expect(readFileSync(path.join(state, "calls"), "utf8")).toContain(
      "api --paginate repos/MicaFox-Platform/MicaFox/pulls/42/commits?per_page=100 --jq",
    );
  });

  it("annotates the failure for the GitHub Actions summary", () => {
    setCommits([commit("a1b2c3d4e5f6", "feat: one", "unsigned")]);

    const result = runPr([["GITHUB_ACTIONS", "true"]]);

    expect(result.stdout).toMatch(
      /^::error title=Unverified commits::.*a1b2c3d feat: one \(unsigned\)%0A.*how to sign/m,
    );
  });
});

describe("check-signatures.sh commits", () => {
  const signWithSshKey = (): void => {
    const key = path.join(state, "key");
    const keygen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8" });
    expect({ status: keygen.status, stderr: keygen.stderr }).toEqual({ status: 0, stderr: "" });
    git("config", "gpg.format", "ssh");
    git("config", "user.signingkey", `${key}.pub`);
  };

  it("fails on a commit that is not signed at all, with the how-to", () => {
    const unsigned = commitFile("unsigned", false);

    const result = runCommits(unsigned);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsigned (unsigned)");
    expect(result.stderr).toContain(HOW_TO);
  });

  it("passes a commit that carries a signature, whether or not git trusts the key", () => {
    signWithSshKey();
    const signed = commitFile("signed", true);

    const result = runCommits(signed);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ commit signatures");
  });

  it("checks only the commits on no remote yet", () => {
    const pushed = commitFile("pushed", false);
    git("update-ref", "refs/remotes/origin/staging", pushed);
    signWithSshKey();
    const local = commitFile("local", true);

    const result = runCommits(local, "--not", "--remotes");

    expect(result.status).toBe(0);
  });

  it("lists every unsigned commit of the push", () => {
    commitFile("first", false);
    const tip = commitFile("second", false);

    const result = runCommits(tip, "--not", "--remotes");

    expect(result.stderr).toContain("first (unsigned)");
    expect(result.stderr).toContain("second (unsigned)");
  });

  it("fails instead of passing when git cannot list the commits", () => {
    const result = runCommits("no-such-ref");

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("✓");
  });
});

describe("check-signatures.sh usage", () => {
  it("exits 2 and prints the usage without a mode", () => {
    const result = spawnSync("bash", [SCRIPT], { cwd: dir, env: GIT_ENV, encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: check-signatures.sh pr <repo> <number> | commits <git log args>");
  });
});
