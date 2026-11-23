import { createVitestConfig } from "@micafox/configs/vitest";
import { defineProject, mergeConfig } from "vitest/config";

// Each test database and each hub on pglite:memory boots its own PGlite, a Postgres compiled to WASM: about 3 s on a
// CI runner while the other test files boot theirs in parallel, so the 5 s default fails tests that are only slow
export default mergeConfig(createVitestConfig(), defineProject({ test: { testTimeout: 20_000, hookTimeout: 20_000 } }));
