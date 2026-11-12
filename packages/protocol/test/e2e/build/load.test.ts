import { describe, expect, it } from "vitest";

import { runAsModule, runAsScript } from "./run-node.js";
import * as source from "../../../src/index.js";

describe("the built @micafox/protocol", () => {
  it("exports its values to import", async () => {
    const run = await runAsModule(
      `import * as protocol from "@micafox/protocol"; console.log(JSON.stringify(protocol));`,
    );

    const shown: unknown = JSON.parse(run.stdout);
    expect(shown).toEqual({ ...source });
  });

  it("exports its values to require()", async () => {
    const run = await runAsScript(`console.log(JSON.stringify(require("@micafox/protocol")));`);

    const shown: unknown = JSON.parse(run.stdout);
    expect(shown).toEqual({ ...source });
  });

  it("prints no ExperimentalWarning when it is loaded with import", async () => {
    const run = await runAsModule(`await import("@micafox/protocol");`);

    expect(run.stderr).not.toContain("ExperimentalWarning");
  });

  it("prints no ExperimentalWarning when it is loaded with require()", async () => {
    const run = await runAsScript(`require("@micafox/protocol");`);

    expect(run.stderr).not.toContain("ExperimentalWarning");
  });

  it("loads its CommonJS build, no ES module file, when it is loaded with require()", async () => {
    const run = await runAsScript(
      `require("@micafox/protocol"); console.log(JSON.stringify(Object.keys(require.cache).filter((file) => file.includes("/packages/"))));`,
    );

    const loaded: unknown = JSON.parse(run.stdout);
    expect(loaded).toEqual([expect.stringContaining("/packages/protocol/dist/cjs/index.js")]);
  });
});
