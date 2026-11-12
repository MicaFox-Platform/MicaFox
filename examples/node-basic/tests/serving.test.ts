import { describe, expect, it } from "vitest";

import {
  E2E_TEST_TIMEOUT_MS,
  fetchInARow,
  startApp,
  startHub,
  toAppUrl,
  useProcesses,
  waitForStatus,
} from "./harness.js";

const REQUESTS = 100;

describe("serving while debugged", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("answers 100 requests in a row on a breakpointed line, past the breakpoint's rate limit", async () => {
    const hub = await startHub();
    const app = await startApp({ hubPort: hub.port });
    await waitForStatus(hub.run, "bp-quote", (status) => status.status === "active");

    const statuses = await fetchInARow(toAppUrl(app.port, "/price"), REQUESTS);

    expect(statuses).toEqual(Array.from({ length: REQUESTS }, () => 200));
  });
});
