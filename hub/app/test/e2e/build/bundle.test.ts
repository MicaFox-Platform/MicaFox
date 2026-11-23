import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DIST, HUB, logLinesOf, readMetafile, runBuiltHub } from "./built-hub.js";

// Nothing listens on port 1, so the hub logs a refused connection, with its stack, until the timeout stops it
const UNREACHABLE_LINES = [
  "MICAFOX_DATABASE_URL=postgres://micafox:secret@127.0.0.1:1/micafox",
  "MICAFOX_PUBLIC_URL=http://localhost:8080",
];

describe("the hub bundle", () => {
  it("ships the PGlite seed and a source map for each bundle file", () => {
    const bundles = Object.keys(readMetafile().outputs).filter((output) => output.endsWith(".js"));

    expect(existsSync(path.join(DIST, "pglite-seed.tar.gz"))).toBe(true);
    expect(bundles.map((bundle) => existsSync(path.join(HUB, `${bundle}.map`)))).not.toContain(false);
  });

  it("leaves only PGlite and pg's optional pg-native outside the bundle", () => {
    const externals = new Set(
      Object.values(readMetafile().outputs).flatMap((output) =>
        output.imports.filter((entry) => entry.external === true && !isBuiltin(entry.path)).map((entry) => entry.path),
      ),
    );

    expect([...externals].sort()).toEqual(["@electric-sql/pglite", "pg-native"]);
  });

  it("logs stack traces that point at the sources", () => {
    const result = runBuiltHub(["migrate"], UNREACHABLE_LINES, { timeout: 3_000, killSignal: "SIGTERM" });

    const unreachable = logLinesOf(result.stdout).find((line) => line.key === "db.unreachable");

    expect((unreachable?.err as { stack?: string } | undefined)?.stack).toMatch(/hub[\\/]core[\\/]src[\\/]/);
  });
});
