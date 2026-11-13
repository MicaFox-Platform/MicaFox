import { E2E_TEST_TIMEOUT_MS, useProcesses, waitForStatus } from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { startApp, startHub } from "./harness.js";

describe("handshake with the hub", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("sends a hello with the service and labels from MICAFOX_* before any breakpoint status", async () => {
    const hub = await startHub();
    await startApp({ hubPort: hub.port, service: "checkout", labels: "team=payments,region=eu" });

    await waitForStatus(hub.run, "bp-quote");

    expect(hub.run.messages()[0]).toEqual(
      expect.objectContaining({ type: "hello", service: "checkout", labels: { team: "payments", region: "eu" } }),
    );
  });
});
