import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_DIR = path.resolve(import.meta.dirname, "../../..");

/** What a child process wrote and its exit code; a failing exit does not reject. */
export interface NodeRun {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs `node` with the package as its working directory, so the package's own name resolves through its `exports`
 * to the built output, as it does for an app that installed it.
 */
export const runNode = async (args: string[]): Promise<NodeRun> => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: PACKAGE_DIR, timeout: 30_000 });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    // A child that exits non-zero rejects with its output attached; the tests assert on that output
    const failed = error as NodeJS.ErrnoException & { stdout: string; stderr: string; code: number };
    return { stdout: failed.stdout, stderr: failed.stderr, code: failed.code };
  }
};

/** Runs `source` as an ES module: `import` of the package. */
export const runAsModule = (source: string): Promise<NodeRun> => runNode(["--input-type=module", "-e", source]);

/** Runs `source` as a CommonJS script: `require()` of the package. */
export const runAsScript = (source: string): Promise<NodeRun> => runNode(["--input-type=commonjs", "-e", source]);
