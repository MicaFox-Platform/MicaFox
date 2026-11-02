import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, toAppUrl, useProcesses } from "./harness.js";

describe("shutdown", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it.each(["SIGTERM", "SIGINT"] as const)(
    "delivers a snapshot sent just before %s and exits with code 0",
    async (signal) => {
      const hub = await startHub({ breakpoints: [] });
      const app = await startApp({ hubPort: hub.port });
      // close() before the app has the hub's welcome would send nothing
      await app.run.waitForLines((line) => line === "connector status: connected");
      await fetch(toAppUrl(app.port, "/demo/snapshot"), { method: "POST" });

      app.run.stop(signal);
      const exitCode = await app.run.exited;
      const [snapshot] = await hub.run.waitForMessages("snapshot");

      expect({ exitCode, breakpointId: snapshot?.breakpointId }).toEqual({
        exitCode: 0,
        breakpointId: "demo-snapshot",
      });
    },
  );
});
