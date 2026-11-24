import { buildPgliteSeed, createFeatureRegistry, runHub, runMigrations } from "@micafox/hub-core";
import type { RunHubProcess } from "@micafox/hub-core";
import { fileURLToPath } from "node:url";

import type { HubBuild } from "./conditions.js";
import { EXTENSION, FEATURES } from "./features.js";

// Replaced by esbuild in the build and by Vitest in tests, from package.json and EE (buildDefines in conditions.ts)
declare const MICAFOX_HUB_VERSION: string;
declare const MICAFOX_HUB_BUILD: HubBuild;

/** What `micafox-hub version` prints and the hub logs when it starts. */
export interface HubInfo {
  version: string;
  build: HubBuild;
}

/** This hub's version and build. */
export const HUB_INFO: HubInfo = { version: MICAFOX_HUB_VERSION, build: MICAFOX_HUB_BUILD };

// Next to dist/server/, where the build writes it; from the sources it is missing, so PGlite starts empty
const PGLITE_SEED = fileURLToPath(new URL("../pglite-seed.tar.gz", import.meta.url));

/** `micafox-hub start`: migrates the database, then serves the hub until SIGTERM or SIGINT. */
export const startHub = async (proc: RunHubProcess): Promise<void> => {
  await runHub({ ...HUB_INFO, features: FEATURES, extension: EXTENSION, pgliteSeed: PGLITE_SEED }, proc);
};

/** `micafox-hub migrate`: runs the missing migrations and exits. */
export const migrateHub = async (proc: RunHubProcess): Promise<void> => {
  await runMigrations({ features: FEATURES, extension: EXTENSION, pgliteSeed: PGLITE_SEED }, proc);
};

/** Writes the PGlite seed with every migration of this build applied; the build runs it from the bundle. */
export const buildSeed = async (file: string): Promise<void> => {
  await buildPgliteSeed({
    file,
    packages: createFeatureRegistry(FEATURES, EXTENSION).migrations,
  });
};
