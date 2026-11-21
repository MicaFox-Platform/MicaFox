// The tarball checks of .github/scripts/check-packs.sh (`pnpm test:pack`): each test builds a throwaway workspace with
// a built ES module package and one that depends on it, breaks one thing, and runs the script in it as CI does.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, ".github", "scripts", "check-packs.sh");
// pnpm pack, publint and Are the Types Wrong run once per package
const PACK_TEST_TIMEOUT_MS = 60_000;
const SOURCE_CONDITION = "@micafox/source";
// The developer's git config must not matter: the script only needs the repository's root
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries([
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
  ]),
};

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly type: "module";
  readonly license: string;
  readonly files: readonly string[];
  readonly exports: Record<string, unknown>;
  readonly publishConfig: { readonly exports: Record<string, unknown> };
  readonly dependencies?: Record<string, string>;
}

let repo: string;

const write = (file: string, content: string): void => {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const BUILT_ENTRY = { types: "./dist/index.d.ts", default: "./dist/index.js" };

const manifest = (name: string, overrides: Partial<Manifest> = {}): Manifest => ({
  name,
  version: "0.1.0",
  type: "module",
  license: "MIT",
  files: ["dist"],
  exports: { ".": { [SOURCE_CONDITION]: "./src/index.ts", ...BUILT_ENTRY } },
  publishConfig: { exports: { ".": BUILT_ENTRY } },
  ...overrides,
});

/** A package as `pnpm build` leaves it: sources, a README and the built ES module with its types. */
const writePackage = (directory: string, packageManifest: Manifest): void => {
  write(`packages/${directory}/package.json`, JSON.stringify(packageManifest, undefined, 2));
  write(`packages/${directory}/README.md`, `# ${packageManifest.name}\n`);
  write(`packages/${directory}/src/index.ts`, "export const answer = 42;\n");
  write(`packages/${directory}/dist/index.js`, "export const answer = 42;\n");
  write(`packages/${directory}/dist/index.d.ts`, "export declare const answer = 42;\n");
};

const createWorkspace = (): void => {
  repo = mkdtempSync(path.join(tmpdir(), "micafox-packs-"));
  spawnSync("git", ["init", "--quiet"], { cwd: repo, env: GIT_ENV });
  write("package.json", JSON.stringify({ name: "fixture", private: true }));
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("LICENSE", "MIT License\n");
  writePackage("core", manifest("@fixture/core"));
  writePackage("app", manifest("@fixture/app", { dependencies: { "@fixture/core": "workspace:^" } }));
  // pnpm pack resolves `workspace:` ranges only for installed dependencies; the fixture has no others, so no network
  const install = spawnSync("pnpm", ["install", "--offline", "--silent"], {
    cwd: repo,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (install.status !== 0) {
    throw new Error(`pnpm install in the fixture failed: ${install.stderr}`);
  }
};

const run = (): SpawnSyncReturns<string> => spawnSync("bash", [SCRIPT], { cwd: repo, env: GIT_ENV, encoding: "utf8" });

beforeEach(createWorkspace);
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check-packs.sh", { timeout: PACK_TEST_TIMEOUT_MS }, () => {
  it("passes packages that ship only their build, a README, the root LICENSE and caret ranges", () => {
    const result = run();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("skips a private package, which is never published", () => {
    write("packages/hub/package.json", JSON.stringify({ name: "@fixture/hub", version: "0.0.0", private: true }));
    write("packages/hub/src/index.ts", "export {};\n");

    const result = run();

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails when the tarball ships the sources", () => {
    writePackage("core", manifest("@fixture/core", { files: ["dist", "src"] }));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✗ @fixture/core: the tarball ships src/index.ts: narrow "files"');
  });

  it("fails when the tarball ships a test", () => {
    write("packages/core/dist/index.test.js", "export {};\n");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @fixture/core: the tarball ships dist/index.test.js");
  });

  it("fails when the tarball ships a .test.tsx file", () => {
    write("packages/core/dist/button.test.tsx", "export {};\n");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @fixture/core: the tarball ships dist/button.test.tsx");
  });

  it("fails when a package has no README", () => {
    rmSync(path.join(repo, "packages/core/README.md"));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @fixture/core: the tarball has no README.md");
  });

  it("fails when publishConfig.exports differ from the exports without the source condition", () => {
    const drifted = { ".": { types: "./dist/index.d.ts", default: "./dist/other.js" } };
    writePackage("core", manifest("@fixture/core", { publishConfig: { exports: drifted } }));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `✗ @fixture/core: the packed exports differ from exports without "${SOURCE_CONDITION}"`,
    );
  });

  it("fails on a workspace dependency that would ship as an exact version", () => {
    writePackage("app", manifest("@fixture/app", { dependencies: { "@fixture/core": "workspace:*" } }));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('✗ @fixture/app: @fixture/core is "workspace:*": use "workspace:^"');
  });

  it("fails when an export points at a file the tarball does not have", () => {
    rmSync(path.join(repo, "packages/core/dist/index.d.ts"));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("✗ @fixture/core: publint found problems:");
  });
});
