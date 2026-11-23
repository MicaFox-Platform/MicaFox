import type { PGlite } from "@electric-sql/pglite";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

// A folder with any file in it is either a database or the leftovers of one: extracting the seed over it would mix
// the two, and PGlite refuses to load a tarball into a folder that holds a database
const holdsFiles = async (folder: string): Promise<boolean> => {
  try {
    return (await readdir(folder)).length > 0;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * What a new PGlite in `dataDir` (memory without it) starts from: the seed's bytes, `"has-database"` when the folder
 * already holds files, or `undefined` when the seed file cannot be found.
 */
export const readSeed = async (
  seed: string,
  dataDir: string | undefined,
): Promise<Blob | "has-database" | undefined> => {
  if (dataDir !== undefined && (await holdsFiles(dataDir))) {
    return "has-database";
  }
  try {
    return new Blob([await readFile(seed)]);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Saves the data folder of `pglite` as a `.tar.gz` seed. A checkpoint first writes the WAL into the tables, so a
 * hub that starts from the seed does not replay it; only the superuser may checkpoint, hence the role reset.
 */
export const writeSeed = async (pglite: PGlite, file: string): Promise<void> => {
  await pglite.exec("reset role; checkpoint;");
  const data = await pglite.dumpDataDir("gzip");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, new Uint8Array(await data.arrayBuffer()));
};
