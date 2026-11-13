import { afterEach, describe, expect, it, vi } from "vitest";

import { createEnvironment } from "../processes.js";

describe("createEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops the developer's own MICAFOX_* and HUB_* variables and keeps the rest", () => {
    vi.stubEnv("MICAFOX_TOKEN", "developer-token");
    vi.stubEnv("HUB_BREAKPOINTS", "[]");
    vi.stubEnv("LANG", "en_US.UTF-8");

    const environment = createEnvironment();

    expect({
      token: environment.MICAFOX_TOKEN,
      breakpoints: environment.HUB_BREAKPOINTS,
      lang: environment.LANG,
    }).toEqual({ token: undefined, breakpoints: undefined, lang: "en_US.UTF-8" });
  });

  it("sets PORT to 0 whatever the developer's PORT is", () => {
    vi.stubEnv("PORT", "3000");

    const environment = createEnvironment();

    expect(environment.PORT).toBe("0");
  });

  it("drops the variables of the given prefixes and names", () => {
    vi.stubEnv("NEXT_TELEMETRY_DISABLED", "0");
    vi.stubEnv("PRICING_API_KEY", "developer-key");

    const environment = createEnvironment({ prefixes: ["NEXT_"], names: ["PRICING_API_KEY"] });

    expect({ telemetry: environment.NEXT_TELEMETRY_DISABLED, apiKey: environment.PRICING_API_KEY }).toEqual({
      telemetry: undefined,
      apiKey: undefined,
    });
  });
});
