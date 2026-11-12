import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { runAsModule } from "./run-node.js";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "../../..");
const VERSION_FILE = "connector/session/version.js";

describe("SDK_VERSION of the built @micafox/sdk", () => {
  it("equals the version in package.json in both builds", async () => {
    const esm = pathToFileURL(path.join(PACKAGE_DIR, "dist/esm", VERSION_FILE)).href;
    const cjs = path.join(PACKAGE_DIR, "dist/cjs", VERSION_FILE);

    // One child process reads all three, so the test compares strings it never has to cast
    const run = await runAsModule(`
      import { readFileSync } from "node:fs";
      import { createRequire } from "node:module";

      const fromModule = await import(${JSON.stringify(esm)});
      const fromScript = createRequire(process.cwd() + "/")(${JSON.stringify(cjs)});
      const manifest = JSON.parse(readFileSync("package.json", "utf8"));
      console.log([fromModule.SDK_VERSION, fromScript.SDK_VERSION, manifest.version].join("\\n"));
    `);

    const [fromModule, fromScript, manifestVersion] = run.stdout.trim().split("\n");
    expect({ fromModule, fromScript }).toEqual({ fromModule: manifestVersion, fromScript: manifestVersion });
  });
});
