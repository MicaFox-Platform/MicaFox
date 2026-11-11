import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, toAppUrl, useProcesses } from "./harness.js";

describe("app startup", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("serves HTTP when MICAFOX_HUB_URL is not set", async () => {
    const app = await startApp();

    const response = await fetch(toAppUrl(app.port, "/health"));
    const body: unknown = await response.json();

    expect({ status: response.status, body }).toEqual({ status: 200, body: { ok: true } });
  });

  it("exits with code 1 when its port is taken", async () => {
    const hub = await startHub({ breakpoints: [] });

    const started = startApp({ port: hub.port });

    await expect(started).rejects.toThrow(/app exited \(code 1\)[\s\S]*failed to start:/);
  });
});
