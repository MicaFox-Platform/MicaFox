import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, toAppUrl, useProcesses, waitForLog } from "./harness.js";

// Distinctive values, so a match in the output can only be a leak
const HUB_TOKEN = "hub-token-7f3a9c";
const WRONG_TOKEN = "app-token-d81e42";

describe("hub token", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("keeps the app serving HTTP without printing the token when the hub rejects it with 401", async () => {
    const hub = await startHub({ token: HUB_TOKEN, breakpoints: [] });
    const app = await startApp({ hubPort: hub.port, token: WRONG_TOKEN });
    // Both sides have seen the rejected upgrade, so the token was sent before the output is checked
    await hub.run.waitForLines((line) => line === "rejected upgrade: 401");
    await waitForLog(app.run, "the hub rejected the token");

    const response = await fetch(toAppUrl(app.port, "/health"));
    const leaks = [...hub.run.lines, ...app.run.lines].filter((line) => line.includes(WRONG_TOKEN));

    expect({ status: response.status, leaks }).toEqual({ status: 200, leaks: [] });
  });

  it("connects on the first attempt when its token matches", async () => {
    const hub = await startHub({ token: HUB_TOKEN, breakpoints: [] });
    const app = await startApp({ hubPort: hub.port, token: HUB_TOKEN, logLevel: "info" });

    await waitForLog(app.run, "connected to the hub");

    expect(hub.run.lines.filter((line) => line.startsWith("rejected upgrade"))).toEqual([]);
  });
});
