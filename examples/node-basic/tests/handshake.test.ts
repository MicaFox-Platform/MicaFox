import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, useProcesses } from "./harness.js";

describe("handshake with the hub", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("sends a hello with the service and labels, then an active status for every breakpoint", async () => {
    const hub = await startHub({
      breakpoints: [
        { id: "bp-cart", file: "src/cart.ts", line: 12 },
        { id: "bp-pay", file: "src/pay.ts", line: 30 },
      ],
    });
    await startApp({ hubPort: hub.port, service: "checkout", labels: "team=payments,region=eu" });

    await hub.run.waitForMessages("breakpointStatus", 2);

    expect(hub.run.messages()).toEqual([
      expect.objectContaining({ type: "hello", service: "checkout", labels: { team: "payments", region: "eu" } }),
      { version: 1, type: "breakpointStatus", breakpointId: "bp-cart", status: "active" },
      { version: 1, type: "breakpointStatus", breakpointId: "bp-pay", status: "active" },
    ]);
  });
});
