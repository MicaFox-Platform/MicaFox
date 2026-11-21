// The folder rules of .github/scripts/check-structure.sh, run by `pnpm lint`: at most 8 source files per folder, and
// tests only in __tests__/, which holds nothing else. Each test writes files into a throwaway git repository and runs
// the script in it.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "check-structure.sh");
const SRC = "packages/lib/src";

let repo: string;

const writeFiles = (files: string[], src = SRC): void => {
  for (const file of files) {
    const target = path.join(repo, src, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export {};\n");
  }
};

const sources = (count: number, extension: string): string[] =>
  Array.from({ length: count }, (_, index) => `part-${String(index)}.${extension}`);

const run = (): SpawnSyncReturns<string> => spawnSync("bash", [SCRIPT], { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "micafox-structure-"));
  spawnSync("git", ["init", "--quiet"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check-structure.sh", () => {
  it("passes a folder of 8 .ts and .tsx sources with .test.ts and .test.tsx files in __tests__/", () => {
    writeFiles([...sources(4, "ts"), ...sources(4, "tsx").map((file) => file.replace("part", "view"))]);
    writeFiles(["__tests__/part-0.test.ts", "__tests__/view-0.test.tsx", "__tests__/part-1.test-d.ts"]);

    const result = run();

    expect({ status: result.status, stdout: result.stdout.trim() }).toEqual({
      status: 0,
      stdout: "✓ folder structure",
    });
  });

  it("counts .tsx sources toward the 8 files per folder", () => {
    writeFiles([...sources(5, "ts"), ...sources(4, "tsx").map((file) => file.replace("part", "view"))]);

    const result = run();

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: expect.stringContaining(`${SRC} has 9 source files, at most 8`) as unknown,
    });
  });

  it("does not count .test.tsx files as sources", () => {
    writeFiles(sources(9, "test.tsx").map((file) => `__tests__/${file}`));

    const result = run();

    expect(result.status).toBe(0);
  });

  it("rejects a .test.tsx file outside __tests__/", () => {
    writeFiles(["button.tsx", "button.test.tsx"]);

    const result = run();

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: expect.stringContaining(`${SRC}/button.test.tsx is a test outside __tests__/`) as unknown,
    });
  });

  it("rejects a .tsx source inside __tests__/", () => {
    writeFiles(["button.tsx", "__tests__/render.tsx"]);

    const result = run();

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: expect.stringContaining(`${SRC}/__tests__/render.tsx is not a test`) as unknown,
    });
  });

  it.each([
    "hub/core/src",
    "hub/core/test",
    "ee/hub/src",
    "sandbox/formats/src",
    "sandbox/frameworks/fastify/src",
    "tools/testkit/src",
  ])("checks the sources of %s", (src) => {
    writeFiles(sources(9, "ts"), src);

    const result = run();

    expect(result.stderr).toContain(`${src} has 9 source files, at most 8`);
  });
});
