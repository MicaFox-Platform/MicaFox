import { createVitestConfig } from "@micafox/configs/vitest";
import { defineProject, mergeConfig } from "vitest/config";

// The tests of the built output need `pnpm build` first and run through `pnpm test:build`
export default mergeConfig(
  createVitestConfig({ sourceCondition: "@micafox/source" }),
  defineProject({ test: { exclude: ["test/e2e/build/**"] } }),
);
