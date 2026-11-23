import { defineConfig } from "vitest/config";

// Root config holds only global options; per-project options come from each workspace's `vitest.config.ts`
export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "hub/*/vitest.config.ts",
      "ee/*/vitest.config.ts",
      "sandbox/*/vitest.config.ts",
      "sandbox/frameworks/*/vitest.config.ts",
      "tools/*/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["{packages,hub,ee}/*/src/**/*.ts", "{packages,hub,ee}/*/src/**/*.tsx"],
      // hub/app's bin.ts only runs as the built executable, which hub/app's `pnpm test:build` runs
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.test-d.ts", "hub/app/src/bin.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
