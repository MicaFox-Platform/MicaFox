import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readSeed } from "../seed.js";

const folders: string[] = [];

const createFolder = async (): Promise<string> => {
  const folder = await mkdtemp(path.join(tmpdir(), "micafox-read-seed-"));
  folders.push(folder);
  return folder;
};

// A regular file, so a path below it fails with ENOTDIR
const createBlocker = async (): Promise<string> => {
  const blocker = path.join(await createFolder(), "a-file");
  await writeFile(blocker, "");
  return blocker;
};

afterAll(async () => {
  await Promise.all(
    folders.splice(0).map(async (folder) => {
      await rm(folder, { recursive: true, force: true });
    }),
  );
});

describe("readSeed", () => {
  it("gives the seed's bytes for a new database", async () => {
    const seed = path.join(await createFolder(), "seed.tar.gz");
    await writeFile(seed, "seed");

    await expect(readSeed(seed, undefined).then(async (blob) => (blob as Blob).text())).resolves.toBe("seed");
  });

  it("treats a seed path under a file as missing", async () => {
    const blocker = await createBlocker();

    await expect(readSeed(path.join(blocker, "seed.tar.gz"), undefined)).resolves.toBeUndefined();
  });

  it("throws any other read error rather than start an empty database", async () => {
    const folder = await createFolder();

    await expect(readSeed(folder, undefined)).rejects.toThrow(/EISDIR/);
  });

  it("treats a data folder under a file as a new database", async () => {
    const seed = path.join(await createFolder(), "seed.tar.gz");
    await writeFile(seed, "seed");
    const blocker = await createBlocker();

    await expect(readSeed(seed, path.join(blocker, "data"))).resolves.toBeInstanceOf(Blob);
  });

  it("finds a database in a folder that holds files", async () => {
    const folder = await createFolder();
    await writeFile(path.join(folder, "PG_VERSION"), "17");

    await expect(readSeed(path.join(folder, "missing.tar.gz"), folder)).resolves.toBe("has-database");
  });
});
