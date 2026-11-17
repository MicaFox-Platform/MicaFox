import { defineProject } from "vitest/config";

// Run only after `pnpm build`: the app is the Nest CLI's build and loads the SDK from its built `dist/`, so there is no
// vitest.config.ts and `pnpm test` skips it
export default defineProject({ test: { include: ["tests/**/*.test.ts"] } });
