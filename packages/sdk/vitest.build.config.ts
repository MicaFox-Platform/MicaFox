import { defineProject } from "vitest/config";

// Only the tests of the built output: they load `dist/` in child processes, so they run after `pnpm build`. Each
// test starts node or tsc, so the timeout leaves room above the child processes' own timeouts.
export default defineProject({ test: { include: ["test/e2e/build/**/*.test.ts"], testTimeout: 90_000 } });
