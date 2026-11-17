import { defineProject } from "vitest/config";

// The container tests of docker/, run by `pnpm test:docker` only: they need Docker, so neither `pnpm test` nor
// `pnpm verify` runs them. Every test talks to one shared stack in turn, so files and tests never run in parallel
export default defineProject({
  test: {
    include: ["docker/__tests__/*.test.ts"],
    globalSetup: ["docker/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
