import { describe, expect, it } from "vitest";

import { runAsModule } from "./run-node.js";

// One process, both builds: an app can load them through two dependencies (ADR 0013)
const LOAD_BOTH = `
  import { createRequire } from "node:module";
  import { micafox as fromModule } from "@micafox/sdk";

  const require = createRequire(process.cwd() + "/");
  const { micafox: fromScript } = require("@micafox/sdk");
  console.log(JSON.stringify({
    sameDebugger: fromModule === fromScript,
    moduleBuild: import.meta.resolve("@micafox/sdk"),
    scriptBuild: require.resolve("@micafox/sdk"),
  }));
`;

describe("the two builds of @micafox/sdk in one process", () => {
  it("share one micafox", async () => {
    const run = await runAsModule(LOAD_BOTH);

    const shown: unknown = JSON.parse(run.stdout);
    expect(shown).toMatchObject({
      sameDebugger: true,
      moduleBuild: expect.stringContaining("/dist/esm/") as string,
      scriptBuild: expect.stringContaining("/dist/cjs/") as string,
    });
  });
});
