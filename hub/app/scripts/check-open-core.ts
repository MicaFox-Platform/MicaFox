// Fails when the basic hub's server bundle holds a module of ee/ (ADR 0023). Run after `EE=false pnpm build`:
// `pnpm --filter @micafox/hub check-open-core [metafile]`, which reads dist/metafile.json by default. The web build
// and the image get their own checks with their cards.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The parts of an esbuild metafile the check reads. */
export interface Metafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports?: ReadonlyArray<{ path: string; external?: boolean }> }>;
}

/** Where the build ran, which the metafile's input paths are relative to, and the repository's `ee/` folder. */
export interface OpenCoreFolders {
  workingDir: string;
  eeDir: string;
}

const EE_PACKAGE = "@micafox/hub-ee";

const isInside = (file: string, folder: string): boolean => {
  const relative = path.relative(folder, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// @micafox/hub-ee installed rather than linked: node_modules/@micafox/hub-ee/… or pnpm's node_modules/.pnpm/@micafox+hub-ee@…
const isEePackagePath = (input: string): boolean => {
  const parts = input.split(/[\\/]/);
  return parts.some(
    (part, index) => (part === "@micafox" && parts[index + 1] === "hub-ee") || part.startsWith("@micafox+hub-ee@"),
  );
};

const isEePackageImport = (specifier: string): boolean =>
  specifier === EE_PACKAGE || specifier.startsWith(`${EE_PACKAGE}/`);

/**
 * The modules of `ee/` in a build: inputs under `ee/` or of `@micafox/hub-ee`, and imports of `@micafox/hub-ee` left
 * external, which never appear among the inputs. Sorted, each once.
 */
export const findEeModules = (metafile: Metafile, folders: OpenCoreFolders): string[] => {
  const found = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    if (isInside(path.resolve(folders.workingDir, input), folders.eeDir) || isEePackagePath(input)) {
      found.add(input);
    }
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const { path: specifier } of output.imports ?? []) {
      if (isEePackageImport(specifier)) {
        found.add(specifier);
      }
    }
  }
  return [...found].sort();
};

const APP_DIR = path.resolve(import.meta.dirname, "..");
const METAFILE = path.join(APP_DIR, "dist", "metafile.json");

const main = async (metafilePath: string): Promise<number> => {
  const metafile = JSON.parse(await readFile(metafilePath, "utf8")) as Metafile;
  const found = findEeModules(metafile, { workingDir: APP_DIR, eeDir: path.resolve(APP_DIR, "../../ee") });
  if (found.length > 0) {
    process.stderr.write(`The basic hub holds modules of ee/:\n${found.map((module) => `  ${module}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write("The basic hub holds no module of ee/\n");
  return 0;
};

// Only when run as a script; the tests import findEeModules
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv[2] ?? METAFILE);
}
