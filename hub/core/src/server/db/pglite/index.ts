import type { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely";
import type { Dialect } from "kysely";

import { becomeAppRole } from "./app-role.js";

export { APP_ROLE } from "./app-role.js";

/** Where PGlite keeps its data, and what to do once it runs as the app role. */
export interface PgliteOptions {
  /** A folder; without it, memory only. */
  dataDir?: string;
  parsers: Record<number, (value: string) => unknown>;
  onOpen: () => void;
}

// Loaded only for a pglite: URL, so a hub on Postgres never loads PGlite's runtime. A PGlite that cannot become the
// app role is closed, so the next attempt does not open a second one on the same folder
const openAsAppRole = async (options: PgliteOptions): Promise<PGlite> => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { dataDir, parsers } = options;
  const pglite = await PGlite.create({ ...(dataDir === undefined ? {} : { dataDir }), parsers });
  try {
    await becomeAppRole(pglite);
  } catch (error) {
    await pglite.close();
    throw error;
  }
  options.onOpen();
  return pglite;
};

/**
 * The Kysely dialect of the hub on PGlite: Postgres SQL over its one session, as the app role. Kysely lends that
 * session to one caller at a time, so a db.global query never runs inside another organization's transaction.
 */
export const createPgliteDialect = (options: PgliteOptions): Dialect =>
  new PGliteDialect({ pglite: async () => await openAsAppRole(options) });
