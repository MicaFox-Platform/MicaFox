import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, toAppUrl, useProcesses, type ListeningRun } from "./harness.js";

const BREAKPOINTS = [{ id: "bp-cart", file: "src/cart.ts", line: 12 }];

// Starts a hub and the app, waits until the app has reported the breakpoints, then kills the hub
const connectAndKillHub = async (): Promise<{ hub: ListeningRun; app: ListeningRun }> => {
  const hub = await startHub({ breakpoints: BREAKPOINTS });
  const app = await startApp({ hubPort: hub.port });
  await hub.run.waitForMessages("breakpointStatus");
  hub.run.stop("SIGKILL");
  await app.run.waitForLines((line) => line === "connector status: disconnected");
  return { hub, app };
};

describe("hub restart", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("keeps answering HTTP while the hub is down", async () => {
    const { app } = await connectAndKillHub();

    const response = await fetch(toAppUrl(app.port, "/health"));

    expect(response.status).toBe(200);
  });

  it("reconnects to a hub restarted on the same port and reports the breakpoints again", async () => {
    const { hub } = await connectAndKillHub();

    const restarted = await startHub({ port: hub.port, breakpoints: BREAKPOINTS });
    const statuses = await restarted.run.waitForMessages("breakpointStatus");

    expect(statuses).toEqual([{ version: 1, type: "breakpointStatus", breakpointId: "bp-cart", status: "active" }]);
  });
});
