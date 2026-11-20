// The #ee and #ee/web imports of package.json, resolved by Node itself as the builds and `node --conditions` will.
// Until ee/hub exists, the default resolves to the stubs too; the ee/hub card points it at @micafox/hub-ee.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const HUB = path.resolve(import.meta.dirname, "..");

const resolveInHub = (specifier: string, conditions: string[]): string => {
  const result = spawnSync(
    process.execPath,
    [
      ...conditions.map((condition) => `--conditions=${condition}`),
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
    const resolved = resolveInHub(specifier, ["micafox-open-core"]);

    expect(resolved).toBe(stub(file));
  });

  it.each([
    ["#ee", "src/ee-stub.ts"],
    ["#ee/web", "src/web/ee-stub.ts"],
  ])("resolves %s to the stub by default while ee/hub does not exist", (specifier, file) => {
    const resolved = resolveInHub(specifier, []);

    expect(resolved).toBe(stub(file));
  });
});
