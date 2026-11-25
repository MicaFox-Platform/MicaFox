// `pnpm build` of the hub (app.md#building): esbuild bundles the server into dist/server/, then the bundle writes the
// PGlite seed, so the seed holds the migrations of exactly that build. `EE=false` builds the basic hub.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildDefines, buildOf, conditionsOf } from "../src/conditions.js";
import type { HubBuild } from "../src/conditions.js";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const DIST = path.join(APP_DIR, "dist");
const SERVER_DIR = path.join(DIST, "server");

// fastify, pg and pino are CommonJS: in an ES module bundle their require() calls of Node's modules need a require
const REQUIRE_BANNER =
  'import { createRequire as micafoxCreateRequire } from "node:module";\n' +
  "const require = micafoxCreateRequire(import.meta.url);";

const versionOf = async (): Promise<string> => {
  const manifest = JSON.parse(await readFile(path.join(APP_DIR, "package.json"), "utf8")) as { version: string };
  return manifest.version;
};

const bundleServer = async (hubBuild: HubBuild, version: string): Promise<void> => {
  const result = await build({
    absWorkingDir: APP_DIR,
    entryPoints: { index: "src/index.ts", bin: "src/bin.ts" },
    outdir: SERVER_DIR,
    bundle: true,
    // One copy of hub-core and its dependencies, shared by both entries
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    conditions: conditionsOf(hubBuild),
    define: buildDefines(hubBuild, version),
    // PGlite ships WebAssembly and data files it loads beside its own modules; pg-native is pg's optional binding,
    // and bufferutil and utf-8-validate are ws's optional native speedups: never installed, each has a fallback
    external: ["@electric-sql/pglite", "pg-native", "bufferutil", "utf-8-validate"],
    banner: { js: REQUIRE_BANNER },
    metafile: true,
    logLevel: "warning",
  });
  await writeFile(path.join(DIST, "metafile.json"), JSON.stringify(result.metafile));
};

const writeSeed = async (): Promise<void> => {
  const server = (await import(pathToFileURL(path.join(SERVER_DIR, "index.js")).href)) as {
    buildSeed: (file: string) => Promise<void>;
  };
  await server.buildSeed(path.join(DIST, "pglite-seed.tar.gz"));
};

const hubBuild = buildOf(process.env);
await bundleServer(hubBuild, await versionOf());
await writeSeed();
process.stdout.write(`Built the ${hubBuild} into ${path.relative(process.cwd(), DIST)}\n`);
