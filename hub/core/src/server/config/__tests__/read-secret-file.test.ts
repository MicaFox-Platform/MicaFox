import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readSecretFile, SecretFileTooLargeError } from "../read-secret-file.js";

const folder = mkdtempSync(path.join(tmpdir(), "micafox-secret-"));

describe("readSecretFile", () => {
  it("returns the text of the file", () => {
    const file = path.join(folder, "db");
    writeFileSync(file, "postgres://app:pw@db/hub\n");

    expect(readSecretFile(file)).toBe("postgres://app:pw@db/hub\n");
  });

  it("refuses a file over 64 KiB", () => {
    const file = path.join(folder, "big");
    writeFileSync(file, "x".repeat(64 * 1024 + 1));

    expect(() => readSecretFile(file)).toThrow(SecretFileTooLargeError);
  });

  it("reads a file of exactly 64 KiB whole", () => {
    const file = path.join(folder, "limit");
    writeFileSync(file, "x".repeat(64 * 1024));

    expect(readSecretFile(file)).toHaveLength(64 * 1024);
  });

  it("throws for a missing file", () => {
    expect(() => readSecretFile(path.join(folder, "missing"))).toThrow(/ENOENT/);
  });
});
