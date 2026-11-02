import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, toAppUrl, useProcesses } from "./harness.js";

describe("demo snapshot", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("delivers the snapshot of POST /demo/snapshot to the hub", async () => {
    const hub = await startHub({ breakpoints: [] });
    const app = await startApp({ hubPort: hub.port });

    const response = await fetch(toAppUrl(app.port, "/demo/snapshot"), { method: "POST" });
    const [snapshot] = await hub.run.waitForMessages("snapshot");

    expect({ status: response.status, breakpointId: snapshot?.breakpointId }).toEqual({
      status: 202,
      breakpointId: "demo-snapshot",
    });
  });
});
