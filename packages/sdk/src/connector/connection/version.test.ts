import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SDK_VERSION } from "./version.js";

const PACKAGE_JSON = path.resolve(import.meta.dirname, "../../../package.json");

describe("SDK_VERSION", () => {
  it("equals the version in the SDK's package.json", async () => {
    const manifest: unknown = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));

    expect(manifest).toMatchObject({ version: SDK_VERSION });
  });
});
