import { describe, expect, it } from "vitest";

import { createVitestConfig } from "../vitest/index.js";

describe("createVitestConfig", () => {
  it("runs .test.ts and .test.tsx files", () => {
    const config = createVitestConfig();

    expect(config.test?.include).toEqual(["**/*.test.ts", "**/*.test.tsx"]);
  });

  it("resolves the source condition before Vite's client defaults when one is given", () => {
    const config = createVitestConfig({ sourceCondition: "@acme/source" });

    expect(config.resolve?.conditions).toEqual(["@acme/source", "module", "browser", "development|production"]);
  });

  it("resolves the source condition before Vite's server defaults when one is given", () => {
    const config = createVitestConfig({ sourceCondition: "@acme/source" });

    expect(config.ssr?.resolve?.conditions).toEqual(["@acme/source", "module", "node", "development|production"]);
  });

  it("keeps Vite's default conditions when no source condition is given", () => {
    const config = createVitestConfig();

    expect(config.resolve).toBeUndefined();
    expect(config.ssr).toBeUndefined();
  });
});
