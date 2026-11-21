import { defineProject } from "vitest/config";

// Run only after `pnpm build`: the apps load the SDK from `dist/`, so there is no vitest.config.ts and `pnpm test` skips
// them
export default defineProject({ test: { include: ["tests/**/*.test.ts"] } });
