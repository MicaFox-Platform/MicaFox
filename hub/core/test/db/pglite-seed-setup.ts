import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

import { buildPgliteSeed } from "../../src/server/db/index.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** A PGlite seed with hub-core's migrations run, built once per test run: `openTestDatabase({ migrated })`. */
    pgliteSeed: string;
  }
}

/**
 * Runs hub-core's migrations once, before any test file, into the seed that migrated test databases start from, so no
 * test runs them again on a new PGlite.
 */
export const setup = async (project: TestProject): Promise<() => Promise<void>> => {
  const folder = await mkdtemp(path.join(tmpdir(), "micafox-test-seed-"));
  const file = path.join(folder, "core.tar.gz");
  await buildPgliteSeed({ file });
  project.provide("pgliteSeed", file);
  return async () => {
    await rm(folder, { recursive: true, force: true });
  };
};
