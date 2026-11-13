// Bundled output is not supported (docs/api/sdk/debugger.md): these tests record what a bundled app reports today, so a
// change to it shows up here. The breakpoint stays `pending` because the debugger reads the source map only of scripts
// whose file name matches the breakpoint's (docs/architecture/sdk/debugger.md, loading a source map), and the bundle is
// `server.cjs`, not `quote.*`. A change to that rule fails these tests on purpose; it is not flakiness.

import { E2E_TEST_TIMEOUT_MS, readStatus, useProcesses } from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { BUNDLED_APP, startApp, startHub, toQuoteUrl } from "./harness.js";

describe("an app bundled with the SDK", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("reports its breakpoint as pending, captures nothing and keeps serving", async () => {
    const hub = await startHub(BUNDLED_APP);
    const app = await startApp(BUNDLED_APP, hub.port);
    await hub.run.waitForMessages("breakpointStatus");

    const response = await fetch(toQuoteUrl(app.port));
    // stop() on SIGTERM sends the buffered snapshots before the connection closes, and the fake hub prints
    // `disconnected` after the connection's last message, so the hub's output below is complete
    app.run.stop("SIGTERM");
    await hub.run.waitForLines((line) => line === "disconnected");
    const statuses = hub.run.lines.flatMap((line) => readStatus(line)?.status ?? []);

    expect({
      httpStatus: response.status,
      statuses,
      snapshots: hub.run.messages().filter((message) => message.type === "snapshot"),
      exitCode: await app.run.exited,
    }).toEqual({ httpStatus: 200, statuses: ["pending"], snapshots: [], exitCode: 0 });
  });
});
