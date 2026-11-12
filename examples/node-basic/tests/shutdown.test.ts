import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, startApp, startHub, toAppUrl, useProcesses, waitForStatus } from "./harness.js";

describe("shutdown", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it.each(["SIGTERM", "SIGINT"] as const)(
    "delivers a snapshot taken just before %s and exits with code 0",
    async (signal) => {
      const hub = await startHub();
      const app = await startApp({ hubPort: hub.port });
      await waitForStatus(hub.run, "bp-quote", (status) => status.status === "active");
      await fetch(toAppUrl(app.port, "/price"));

      app.run.stop(signal);
      const exitCode = await app.run.exited;
      const [snapshot] = await hub.run.waitForMessages("snapshot");

      expect({ exitCode, breakpointId: snapshot?.breakpointId }).toEqual({ exitCode: 0, breakpointId: "bp-quote" });
    },
  );
});
