import { createVitestConfig } from "@micafox/configs/vitest";
import { mergeConfig } from "vitest/config";

// docker/ needs Docker and runs through vitest.docker.config.ts only; mergeConfig() appends to the preset's excludes
export default mergeConfig(createVitestConfig({ sourceCondition: "@micafox/source" }), {
  test: { exclude: ["docker/**"] },
});
