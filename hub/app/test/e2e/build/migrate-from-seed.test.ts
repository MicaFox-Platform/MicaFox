import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { logLinesOf, runBuiltHub, TEST_MODE_LINES } from "./built-hub.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map(async (folder) => {
      await rm(folder, { recursive: true, force: true });
    }),
  );
});

const messagesOf = (stdout: string): unknown[] => logLinesOf(stdout).map((line) => line.msg);

describe("micafox-hub migrate on the built hub", () => {
  it("migrates pglite:memory from the seed, so no migration runs, and exits with 0", () => {
    const result = runBuiltHub(["migrate"]);

    expect(result.status).toBe(0);
    expect(messagesOf(result.stdout)).toContain("db.migrations-done");
    expect(messagesOf(result.stdout)).not.toContain("db.migrated");
  });

  it("migrates a new pglite:<folder> from the seed, so no migration runs, and exits with 0", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "micafox-built-"));
    folders.push(folder);
    const lines = [
      ...TEST_MODE_LINES.filter((line) => !line.startsWith("MICAFOX_DATABASE_URL=")),
      `MICAFOX_DATABASE_URL=pglite:${path.join(folder, "data")}`,
    ];

    const result = runBuiltHub(["migrate"], lines);

    expect(result.status).toBe(0);
    expect(messagesOf(result.stdout)).not.toContain("db.migrated");
  });
});
