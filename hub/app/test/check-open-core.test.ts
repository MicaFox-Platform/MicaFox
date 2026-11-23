import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { findEeModules } from "../scripts/check-open-core.js";
import type { Metafile } from "../scripts/check-open-core.js";

const HUB = path.resolve(import.meta.dirname, "..");
const FOLDERS = { workingDir: HUB, eeDir: path.resolve(HUB, "../../ee") };

const metafileOf = (inputs: readonly string[], imports: ReadonlyArray<{ path: string; external?: boolean }> = []) =>
  ({
    inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 1 }])),
    outputs: { "dist/server/index.js": { imports } },
  }) satisfies Metafile;

describe("findEeModules", () => {
  it("finds an input under ee/, written relative to the folder the build ran in", () => {
    const metafile = metafileOf(["src/index.ts", "../../ee/hub/src/server/index.ts"]);

    expect(findEeModules(metafile, FOLDERS)).toEqual(["../../ee/hub/src/server/index.ts"]);
  });

  it("finds @micafox/hub-ee installed into node_modules rather than linked from ee/", () => {
    const metafile = metafileOf([
      "../../node_modules/.pnpm/@micafox+hub-ee@1.2.0/node_modules/@micafox/hub-ee/dist/index.js",
      "node_modules/@micafox/hub-ee/dist/web.js",
    ]);

    expect(findEeModules(metafile, FOLDERS)).toHaveLength(2);
  });

  it("finds an import of @micafox/hub-ee left external, which is not among the inputs", () => {
    const metafile = metafileOf(["src/index.ts"], [{ path: "@micafox/hub-ee/web", external: true }]);

    expect(findEeModules(metafile, FOLDERS)).toEqual(["@micafox/hub-ee/web"]);
  });

  it("passes modules whose path only contains ee, such as a package named fee", () => {
    const metafile = metafileOf(
      ["src/ee-stub.ts", "../../node_modules/.pnpm/fee@1.0.0/node_modules/fee/index.js", "../../hub/core/src/x.ts"],
      [{ path: "@electric-sql/pglite", external: true }],
    );

    expect(findEeModules(metafile, FOLDERS)).toEqual([]);
  });
});

describe("check-open-core", () => {
  it("fails with exit code 1 and names each module of ee/ in a build that holds them", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-open-core.ts", "test/open-core/ee-metafile.json"],
      { cwd: HUB, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("../../ee/hub/src/server/index.ts");
    expect(result.stderr).toContain("@micafox/hub-ee/web");
    expect(result.stderr).not.toContain("fee");
  });
});
