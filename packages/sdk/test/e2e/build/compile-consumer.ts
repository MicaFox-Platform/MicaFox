import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = "@micafox/sdk";
const PACKAGE_DIR = path.resolve(import.meta.dirname, "../../..");
const REPO_DIR = path.resolve(PACKAGE_DIR, "../..");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/** tsc's output and exit code; a failing compile does not reject. */
export interface TscRun {
  output: string;
  code: number;
}

/**
 * Typechecks `files` as an app that installed the package does, with `node16` resolution, and lists the files tsc
 * read, so a test can tell which build's declarations it used. Nothing is emitted.
 */
export const compileConsumer = async (files: Record<string, string>): Promise<TscRun> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "micafox-consumer-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      await writeFile(path.join(dir, file), source);
    }
    // A link, as pnpm installs a workspace package: tsc follows it to the package's real files
    await mkdir(path.join(dir, "node_modules/@micafox"), { recursive: true });
    await symlink(PACKAGE_DIR, path.join(dir, "node_modules", PACKAGE_NAME), "dir");
    const config = {
      compilerOptions: {
        module: "node16",
        moduleResolution: "node16",
        target: "es2022",
        strict: true,
        noEmit: true,
        types: ["node"],
        typeRoots: [path.join(REPO_DIR, "node_modules/@types")],
      },
      files: Object.keys(files),
    };
    await writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(config));
    try {
      const { stdout } = await execFileAsync(process.execPath, [TSC, "-p", dir, "--listFiles"], { timeout: 60_000 });
      return { output: stdout, code: 0 };
    } catch (error) {
      // tsc exits non-zero on a type error, and the rejection carries its output
      const failed = error as { stdout: string; code: number };
      return { output: failed.stdout, code: failed.code };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
