import path from "node:path";
import { describe, expect, it } from "vitest";

import { BIN, DIST, runBuiltHub } from "./built-hub.js";

describe("the built micafox-hub command", () => {
  it("is what the ./cli export resolves to", () => {
    expect(BIN).toBe(path.join(DIST, "server", "bin.js"));
  });

  it("prints the version and the ee edition of the default build with version", () => {
    const result = runBuiltHub(["version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\S* \(ee\)\n$/);
  });

  it("exits with 2 and the usage for an unknown command", () => {
    const result = runBuiltHub(["serve"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: micafox-hub <command>");
  });
});
