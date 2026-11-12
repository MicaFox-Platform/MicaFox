import { describe, expect, it } from "vitest";

import {
  E2E_TEST_TIMEOUT_MS,
  startApp,
  startHub,
  toAppUrl,
  useProcesses,
  waitForStatus,
  type ListeningRun,
} from "./harness.js";

// Starts a hub and the app, waits until the breakpoint is active, then kills the hub and waits until it has exited
const connectAndKillHub = async (): Promise<{ hub: ListeningRun; app: ListeningRun }> => {
  const hub = await startHub();
  const app = await startApp({ hubPort: hub.port });
  await waitForStatus(hub.run, "bp-quote", (status) => status.status === "active");
  hub.run.stop("SIGKILL");
  await hub.run.exited;
  return { hub, app };
};

describe("hub restart", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("keeps answering on the breakpointed line while the hub is down", async () => {
    const { app } = await connectAndKillHub();

    const response = await fetch(toAppUrl(app.port, "/price"));

    expect(response.status).toBe(200);
  });

  it("sends the breakpoint statuses again to a hub restarted on the same port", async () => {
    const { hub } = await connectAndKillHub();

    const restarted = await startHub({ port: hub.port });
    // The breakpoint is still set in the app, so the first status the new hub gets is active, never pending
    const status = await waitForStatus(restarted.run, "bp-quote");

    expect(status.status).toBe("active");
  });
});
