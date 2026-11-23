// The #ee and #ee/web imports of package.json, resolved by Node itself as the builds and `node --conditions` will.
// Until ee/hub exists, the default resolves to the stubs too; the ee/hub card points it at @micafox/hub-ee.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { nodeConditionFlags, OPEN_CORE_CONDITION } from "../src/conditions.js";
import type { HubBuild } from "../src/conditions.js";

const HUB = path.resolve(import.meta.dirname, "..");

const resolveInHub = (specifier: string, build: HubBuild): string => {
  const result = spawnSync(
    process.execPath,
    [
      ...nodeConditionFlags(build),
      "--input-type=module",
      "--eval",
      `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`,
    ],
    { cwd: HUB, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`node could not resolve ${specifier}: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const stub = (file: string): string => pathToFileURL(path.join(HUB, file)).href;

describe("#ee imports", () => {
  it.each([
    ["#ee", "src/ee-stub.ts"],
    ["#ee/web", "src/web/ee-stub.ts"],
  ])("resolves %s to the basic hub's stub under micafox-open-core", (specifier, file) => {
    const resolved = resolveInHub(specifier, "basic-hub");

    expect(resolved).toBe(stub(file));
  });

  it.each([
    ["#ee", "src/ee-stub.ts"],
    ["#ee/web", "src/web/ee-stub.ts"],
  ])("resolves %s to the stub by default while ee/hub does not exist", (specifier, file) => {
    const resolved = resolveInHub(specifier, "hub");

    expect(resolved).toBe(stub(file));
  });
});

describe("the basic hub's typecheck", () => {
  it("resolves under the same condition as the builds, which tsc can only read from JSON", () => {
    const tsconfig = JSON.parse(
      readFileSync(path.join(HUB, "tsconfig.open-core.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ) as { compilerOptions: { customConditions: string[] } };

    expect(tsconfig.compilerOptions.customConditions).toEqual([OPEN_CORE_CONDITION]);
  });
});
