import { defineProject } from "vitest/config";

// Only the tests of the built output: they run dist/server/bin.js in child processes, so they run after `pnpm build`
export default defineProject({ test: { include: ["test/e2e/build/**/*.test.ts"], testTimeout: 60_000 } });
