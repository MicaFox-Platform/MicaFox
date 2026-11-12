import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const PRESET = path.resolve(import.meta.dirname, "../tsconfig/workspace-cjs.json");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

// Typechecks one source file of a package that extends the preset; a failing compile returns tsc's output
const compileWithPreset = async (source: string): Promise<{ output: string; code: number }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "micafox-preset-"));
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src/index.ts"), source);
    // Only what a type check of one file needs: no Node types, no build info, nothing emitted
    const compilerOptions = {
      types: [],
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      noEmit: true,
    };
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({ extends: PRESET, compilerOptions }));
    try {
      await execFileAsync(process.execPath, [TSC, "-p", dir], { timeout: 60_000 });
      return { output: "", code: 0 };
    } catch (error) {
      // tsc exits non-zero on a type error, and the rejection carries its output
      const failed = error as { stdout: string; code: number };
      return { output: failed.stdout, code: failed.code };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// The CommonJS build cannot express either construct, so a package built with the preset fails on them (ADR 0013)
describe("tsconfig/workspace-cjs.json", { timeout: 90_000 }, () => {
  it("compiles a source file without top-level await or import.meta", async () => {
    const result = await compileWithPreset("export const ready = true;\n");

    expect(result).toEqual({ output: "", code: 0 });
  });

  it("rejects top-level await", async () => {
    const result = await compileWithPreset("await Promise.resolve();\nexport const ready = true;\n");

    expect(result.output).toContain("TS1378");
  });

  it("rejects import.meta", async () => {
    const result = await compileWithPreset("export const url = import.meta.url;\n");

    expect(result.output).toContain("TS1343");
  });
});
