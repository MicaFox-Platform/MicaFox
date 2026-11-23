import type { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely";
import type { Dialect } from "kysely";

import { becomeAppRole } from "./app-role.js";
import { readSeed } from "./seed.js";

export { APP_ROLE } from "./app-role.js";
export { writeSeed } from "./seed.js";

/** Where PGlite keeps its data, what it starts from, and what to do once it runs as the app role. */
export interface PgliteOptions {
  /** A folder; without it, memory only. */
  dataDir?: string;
  /** A migrated data folder as `.tar.gz`, loaded into memory or into a missing or empty folder. */
  seed?: string;
  parsers: Record<number, (value: string) => unknown>;
  onOpen: (pglite: PGlite) => void;
  /** The seed file was given but cannot be read; the database starts empty and runs every migration. */
  onSeedMissing: (seed: string) => void;
}

// What the new PGlite loads: the seed, unless the folder already holds a database or the seed cannot be read
const initialDataOf = async (options: PgliteOptions): Promise<{ loadDataDir?: Blob }> => {
  if (options.seed === undefined) {
    return {};
  }
  const data = await readSeed(options.seed, options.dataDir);
  if (data === "has-database") {
    return {};
  }
  if (data === undefined) {
    options.onSeedMissing(options.seed);
    return {};
  }
  return { loadDataDir: data };
};

// Loaded only for a pglite: URL, so a hub on Postgres never loads PGlite's runtime. A PGlite that cannot become the
// app role is closed, so the next attempt does not open a second one on the same folder
const openAsAppRole = async (options: PgliteOptions): Promise<PGlite> => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { dataDir, parsers } = options;
  const pglite = await PGlite.create({
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(await initialDataOf(options)),
    parsers,
  });
  try {
    await becomeAppRole(pglite);
  } catch (error) {
    await pglite.close();
    throw error;
  }
  options.onOpen(pglite);
  return pglite;
};

/**
 * The Kysely dialect of the hub on PGlite: Postgres SQL over its one session, as the app role. Kysely lends that
 * session to one caller at a time, so a db.global query never runs inside another organization's transaction.
 */
export const createPgliteDialect = (options: PgliteOptions): Dialect =>
  new PGliteDialect({ pglite: async () => await openAsAppRole(options) });
