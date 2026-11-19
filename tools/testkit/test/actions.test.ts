// The pin check of .github/scripts/check-actions.sh, run by `pnpm lint`: every action a workflow uses is pinned by its
// full commit SHA with the version in a comment. Each test writes one workflow into a throwaway git repository and
// runs the script in it.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "check-actions.sh");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

let repo: string;

const writeWorkflow = (file: string, steps: string): void => {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `name: Fixture\non: push\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`);
};

const run = (): SpawnSyncReturns<string> => spawnSync("bash", [SCRIPT], { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "micafox-actions-"));
  spawnSync("git", ["init", "--quiet"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check-actions.sh", () => {
  it("passes when every action is pinned by its commit with the version in a comment", () => {
    writeWorkflow(
      ".github/workflows/ci.yml",
      `      - uses: actions/checkout@${SHA} # v7.0.1\n      - name: Node\n        uses: "actions/setup-node@${SHA}" #v7.1.0\n`,
    );

    const result = run();

    expect({ status: result.status, stdout: result.stdout.trim() }).toEqual({
      status: 0,
      stdout: "✓ actions pinned by commit",
    });
  });

  it.each([
    { reference: "actions/checkout@v7", why: "a tag" },
    { reference: `actions/checkout@${SHA}`, why: "a commit without its version" },
    { reference: "actions/checkout@3d3c42e # v7.0.1", why: "a short commit" },
    { reference: "github/codeql-action/init@main # v4", why: "a branch" },
  ])("fails on $why, naming the file and line", ({ reference }) => {
    writeWorkflow(".github/workflows/ci.yml", `      - run: echo\n      - uses: ${reference}\n`);

    const result = run();

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: expect.stringContaining(
        `.github/workflows/ci.yml:8 uses ${reference.replace(/ #.*$/, "")}: pin it`,
      ) as unknown,
    });
  });

  it("checks the composite actions of the repository too", () => {
    writeWorkflow(".github/workflows/ci.yml", `      - uses: ./.github/actions/setup\n`);
    writeWorkflow(".github/actions/setup/action.yml", `      - uses: pnpm/action-setup@v5\n`);

    const result = run();

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: expect.stringContaining(
        ".github/actions/setup/action.yml:7 uses pnpm/action-setup@v5: pin it",
      ) as unknown,
    });
  });

  it("leaves out the actions of the repository and Docker images", () => {
    writeWorkflow(
      ".github/workflows/ci.yml",
      `      - uses: ./.github/actions/local\n      - uses: docker://alpine:3\n`,
    );

    const result = run();

    expect(result.status).toBe(0);
  });
});
