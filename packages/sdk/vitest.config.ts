import { createVitestConfig } from "@micafox/configs/vitest";
import { defineProject, mergeConfig } from "vitest/config";

// Child processes, not worker threads: the debugger runs only on a main thread, and its tests need a real one.
// The tests of the built output need `pnpm build` first and run through `pnpm test:build`.
export default mergeConfig(
  createVitestConfig({ sourceCondition: "@micafox/source" }),
  defineProject({ test: { pool: "forks", exclude: ["test/e2e/build/**"] } }),
);
