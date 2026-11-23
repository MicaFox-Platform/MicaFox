import { createVitestConfig } from "@micafox/configs/vitest";
import { readFileSync } from "node:fs";
import { defineProject, mergeConfig } from "vitest/config";

import { buildDefines, buildOf, conditionsOf } from "./src/conditions.js";

// The tests resolve and define what the build of EE does (src/conditions.ts); the tests of the built output need
// `pnpm build` first and run through `pnpm test:build`
const build = buildOf(process.env);
const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { version: string };

export default mergeConfig(
  createVitestConfig({ sourceCondition: "@micafox/source", conditions: conditionsOf(build) }),
  defineProject({
    define: buildDefines(build, version),
    // A hub on pglite:memory boots PGlite, about 3 s on a CI runner next to other test files
    test: { exclude: ["test/e2e/build/**"], testTimeout: 20_000, hookTimeout: 20_000 },
  }),
);
