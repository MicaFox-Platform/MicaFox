import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const CONFIGS = path.resolve(import.meta.dirname, "..");
const TSC = require.resolve("typescript/bin/tsc");
const TYPES = ["react", "node"];

const BUTTON = [
  'import styles from "./button.module.css";',
  "",
  'export const Button = (): React.JSX.Element => <button className={styles["root"]}>{document.title}</button>;',
  "",
].join("\n");

// Typechecks src/button.tsx in a package that installs @micafox/configs and extends `preset` by package name, so the
// exports of the package resolve as they do for a user; a failing compile returns tsc's output
const compileButton = async (preset: string): Promise<{ output: string; code: number }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "micafox-preset-"));
  try {
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "node_modules/@types"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/@micafox"));
    await symlink(CONFIGS, path.join(dir, "node_modules/@micafox/configs"));
    for (const name of TYPES) {
      const types = await realpath(path.dirname(require.resolve(`@types/${name}/package.json`)));
      await symlink(types, path.join(dir, "node_modules/@types", name));
    }
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    await writeFile(path.join(dir, "src/button.tsx"), BUTTON);
    const compilerOptions = {
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      noEmit: true,
    };
    const tsconfig = { extends: `@micafox/configs/tsconfig/${preset}`, compilerOptions };
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
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

describe("tsconfig/workspace-react.json", { timeout: 90_000 }, () => {
  it("compiles a component that uses a CSS Module", async () => {
    const result = await compileButton("workspace-react.json");

    expect(result).toEqual({ output: "", code: 0 });
  });

  it("leaves JSX out of tsconfig/workspace.json", async () => {
    const result = await compileButton("workspace.json");

    expect(result.output).toContain("TS17004");
  });
});
