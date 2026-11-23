// The built hub as operators and tools/testkit run it: dist/server/bin.js in a child process, after `pnpm build`
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

export const HUB = path.resolve(import.meta.dirname, "../../..");
export const DIST = path.join(HUB, "dist");
export const BIN = createRequire(path.join(HUB, "package.json")).resolve("@micafox/hub/cli");

export interface Metafile {
  outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }>;
}

export const readMetafile = (): Metafile =>
  JSON.parse(readFileSync(path.join(DIST, "metafile.json"), "utf8")) as Metafile;

// Environment lines read like a .env file, so the setting names stay as operators write them
const envOf = (lines: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    lines.map((line): [string, string] => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );

/** Test mode with a free port on PGlite in memory. */
export const TEST_MODE_LINES = [
  "MICAFOX_TEST_MODE=true",
  "MICAFOX_DATABASE_URL=pglite:memory",
  "MICAFOX_HOST=127.0.0.1",
  "MICAFOX_PORT=0",
];

/** Runs the built hub from a folder outside the repo, as an installed hub runs, with only these settings. */
export const runBuiltHub = (
  args: readonly string[],
  lines: readonly string[] = TEST_MODE_LINES,
  options: Pick<SpawnSyncOptions, "timeout" | "killSignal"> = {},
): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, [BIN, ...args], {
    ...options,
    cwd: tmpdir(),
    encoding: "utf8",
    env: envOf([`PATH=${process.env.PATH ?? ""}`, ...lines]),
  });

/** The JSON log lines the hub wrote to stdout. */
export const logLinesOf = (stdout: string): Array<Record<string, unknown>> =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
