import { describe, expect, it } from "vitest";

import { runAsModule, runAsScript } from "./run-node.js";
import * as source from "../../../src/index.js";

// Each export name with the type of its value: computed from the sources here, and by a child process from the build
const typesOf = (exports: object): Record<string, string> =>
  Object.fromEntries(Object.entries(exports).map(([name, value]) => [name, typeof value]));
const SHOW_TYPES =
  "JSON.stringify(Object.fromEntries(Object.entries(sdk).map(([name, value]) => [name, typeof value])))";

describe("the built @micafox/sdk", () => {
  it("exports the debugger and HubConnector to import", async () => {
    const run = await runAsModule(`import * as sdk from "@micafox/sdk"; console.log(${SHOW_TYPES});`);

    const shown: unknown = JSON.parse(run.stdout);
    expect(shown).toEqual(typesOf(source));
  });

  it("exports the debugger and HubConnector to require()", async () => {
    const run = await runAsScript(`const sdk = require("@micafox/sdk"); console.log(${SHOW_TYPES});`);

    const shown: unknown = JSON.parse(run.stdout);
    expect(shown).toEqual(typesOf(source));
  });

  it("prints no ExperimentalWarning when it is loaded with import", async () => {
    const run = await runAsModule(`await import("@micafox/sdk");`);

    expect(run.stderr).not.toContain("ExperimentalWarning");
  });

  it("prints no ExperimentalWarning when it is loaded with require()", async () => {
    const run = await runAsScript(`require("@micafox/sdk");`);

    expect(run.stderr).not.toContain("ExperimentalWarning");
  });

  it("loads only CommonJS files, its dependency's included, when it is loaded with require()", async () => {
    const run = await runAsScript(
      `require("@micafox/sdk"); console.log(JSON.stringify(Object.keys(require.cache).filter((file) => file.includes("/packages/"))));`,
    );

    const loaded: unknown = JSON.parse(run.stdout);
    expect(loaded).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/packages/protocol/dist/cjs/index.js"),
        expect.stringContaining("/packages/sdk/dist/cjs/index.js"),
      ]),
    );
    expect(loaded).not.toEqual(expect.arrayContaining([expect.stringContaining("/dist/esm/")]));
  });
});
