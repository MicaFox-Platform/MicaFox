import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, toAppUrl, useProcesses, waitForStatus } from "./harness.js";

// A distinctive value, so a match in the output can only be a leak
const API_KEY = "pricing-key-4b9e17";

describe("redaction", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("captures apiKey as redacted and prints its value nowhere in the hub's or the app's output", async () => {
    const hub = await startHub();
    const app = await startApp({ hubPort: hub.port, pricingApiKey: API_KEY });
    await waitForStatus(hub.run, "bp-quote", (status) => status.status === "active");

    await fetch(toAppUrl(app.port, "/price"));
    const [snapshot] = await hub.run.waitForMessages("snapshot");
    const apiKey = snapshot?.variables.find((variable) => variable.name === "apiKey");
    const leaks = [...hub.run.lines, ...app.run.lines].filter((line) => line.includes(API_KEY));

    expect({ apiKey, leaks }).toEqual({ apiKey: { name: "apiKey", value: { type: "redacted" } }, leaks: [] });
  });
});
