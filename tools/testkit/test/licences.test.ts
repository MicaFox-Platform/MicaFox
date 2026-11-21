// The licence checks of .github/scripts/check-licences.sh (`pnpm lint`), against a stand-in for `pnpm licenses list`
// in a throwaway repository that holds the packages of packages/, hub/ and ee/ as in this one.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "check-licences.sh");

// `pnpm --filter <name> licenses list --json --prod`: prints $STATE/<name without scope>.json, or what pnpm prints for
// a package without third-party dependencies, after a warning on stderr as pnpm may print one; exits 1 with an error
// for a package named in $STATE/broken
const PNPM_STUB = `#!/usr/bin/env bash
[[ $1 == --filter ]] || { echo "unexpected call: $*" >&2; exit 2; }
name=\${2##*/}
echo "WARN  Unsupported engine" >&2
if [[ -e $STATE/broken && $(cat "$STATE/broken") == "$name" ]]; then echo "ERR_PNPM_LICENSES_NO_DEPS" >&2; exit 1; fi
answer="$STATE/$name.json"
if [[ -e $answer ]]; then cat "$answer"; else echo "No licenses in packages found"; fi
`;
// Folder and package name, as in this repository
const PACKAGES: Array<{ dir: string; name: string; license: string }> = [
  { dir: "packages/ui", name: "ui", license: "MIT" },
  { dir: "hub/core", name: "hub-core", license: "AGPL-3.0-only" },
  { dir: "hub/debugger", name: "hub-debugger", license: "AGPL-3.0-only" },
  { dir: "hub/app", name: "hub", license: "AGPL-3.0-only" },
];

let repo: string;
let state: string;

// One dependency per licence, as pnpm groups them
const setDependencies = (packageDir: string, licenses: Record<string, string>): void => {
  const byLicense = Object.fromEntries(
    Object.entries(licenses).map(([name, license]) => [license, [{ name, versions: ["1.0.0"], license }]]),
  );
  writeFileSync(path.join(state, `${packageDir}.json`), JSON.stringify(byLicense));
};

const writePackage = (dir: string, manifest: { name: string; license?: string | undefined }): void => {
  mkdirSync(path.join(repo, dir), { recursive: true });
  writeFileSync(path.join(repo, dir, "package.json"), JSON.stringify(manifest));
};

const run = (): SpawnSyncReturns<string> =>
  spawnSync("bash", [SCRIPT], {
    cwd: repo,
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["PATH", [path.join(state, "bin"), process.env.PATH].join(path.delimiter)],
        ["STATE", state],
        ["GIT_CONFIG_GLOBAL", "/dev/null"],
        ["GIT_CONFIG_NOSYSTEM", "1"],
      ]),
    },
    encoding: "utf8",
  });

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "micafox-licences-"));
  state = mkdtempSync(path.join(tmpdir(), "micafox-licences-state-"));
  spawnSync("git", ["init", "--quiet"], { cwd: repo });
  for (const { dir, name, license } of PACKAGES) {
    writePackage(dir, { name: `@micafox/${name}`, license });
  }
  mkdirSync(path.join(state, "bin"));
  writeFileSync(path.join(state, "bin", "pnpm"), PNPM_STUB);
  chmodSync(path.join(state, "bin", "pnpm"), 0o755);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe("check-licences.sh", () => {
  it("passes when the hub packages have no third-party dependency, whatever pnpm warns about", () => {
    const result = run();

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("✓ licences");
  });

  it.each([
    ["hub-core", "GPL-3.0-only"],
    ["hub-debugger", "AGPL-3.0-or-later"],
    ["hub", "SSPL-1.0"],
    ["hub", "GPLv3"],
    ["hub-core", "AGPL"],
  ])("fails when %s depends on a package under %s and names it", (dir, license) => {
    setDependencies(dir, { "copyleft-lib": license });

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`✗ @micafox/${dir}: copyleft-lib@1.0.0 is under ${license}`);
  });

  it("checks a feature package added later without a change to the script", () => {
    writePackage("hub/logpoints", { name: "@micafox/hub-logpoints", license: "AGPL-3.0-only" });
    setDependencies("hub-logpoints", { "copyleft-lib": "GPL-2.0-or-later" });

    const result = run();

    expect(result.stderr).toContain("✗ @micafox/hub-logpoints: copyleft-lib@1.0.0 is under GPL-2.0-or-later");
  });

  it("passes LGPL, MPL and permissive licences in the AGPL packages", () => {
    setDependencies("hub-core", { "lgpl-lib": "LGPL-3.0-only", "mpl-lib": "MPL-2.0", "mit-lib": "MIT" });

    expect(run().status).toBe(0);
  });

  it("passes a choice that offers a non-copyleft licence", () => {
    setDependencies("hub", { "dual-lib": "(GPL-2.0-only OR MIT)" });

    expect(run().status).toBe(0);
  });

  it.each(["Unknown", "UNLICENSED", "SEE LICENSE IN LICENSE", "MIT AND GPL-3.0-only"])(
    "fails on %s, which needs a person to read it",
    (license) => {
      setDependencies("hub-core", { "odd-lib": license });

      const result = run();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`✗ @micafox/hub-core: odd-lib@1.0.0 is under ${license}`);
    },
  );

  it("passes permissive licences and OFL fonts in the UI kit", () => {
    setDependencies("ui", {
      react: "MIT",
      "plex-font": "OFL-1.1",
      "aria-lib": "Apache-2.0",
      "dual-lib": "(MPL-2.0 OR MIT)",
    });

    expect(run().status).toBe(0);
  });

  it.each(["MPL-2.0", "LGPL-3.0-only"])("fails on %s in the UI kit, which is MIT", (license) => {
    setDependencies("ui", { "weak-copyleft-lib": license });

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`✗ @micafox/ui: weak-copyleft-lib@1.0.0 is under ${license}`);
    expect(result.stderr).toContain("only permissive licences");
  });

  it("checks the packages of ee/, which ship in the hub's image", () => {
    writePackage("ee/hub", { name: "@micafox/hub-ee", license: "SEE LICENSE IN LICENSE" });
    setDependencies("hub-ee", { "copyleft-lib": "AGPL-3.0-only" });

    const result = run();

    expect(result.stderr).toContain("✗ @micafox/hub-ee: copyleft-lib@1.0.0 is under AGPL-3.0-only");
  });

  it("fails when pnpm licenses list fails, and shows its error", () => {
    writeFileSync(path.join(state, "broken"), "hub-debugger");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @micafox/hub-debugger: pnpm licenses list failed");
    expect(result.stderr).toContain("ERR_PNPM_LICENSES_NO_DEPS");
  });

  it("fails when pnpm answers with something other than JSON", () => {
    writeFileSync(path.join(state, "hub.json"), "ERR_PNPM_SOMETHING\n");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @micafox/hub: pnpm licenses list printed no JSON object");
  });

  it.each([
    ["packages/sdk", "AGPL-3.0-only", "everything under packages/ is MIT"],
    ["hub/logpoints", "MIT", "everything under hub/ is AGPL-3.0-only"],
    ["hub/logpoints", undefined, "everything under hub/ is AGPL-3.0-only"],
    ["ee/hub", "AGPL-3.0-only", "ee/ is under its own terms"],
  ])("fails when %s declares %s, which its folder does not allow", (dir, license, message) => {
    writePackage(dir, { name: `@micafox/${dir.replace("/", "-")}`, license });

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`✗ ${dir}/package.json: license is "${license ?? ""}": ${message}`);
  });

  it.each(["SEE LICENSE IN LICENSE", "UNLICENSED"])("passes ee/ under its own terms: %s", (license) => {
    writePackage("ee/hub", { name: "@micafox/hub-ee", license });

    expect(run().status).toBe(0);
  });
});
