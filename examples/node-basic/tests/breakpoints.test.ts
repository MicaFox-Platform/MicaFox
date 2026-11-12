import { describe, expect, it } from "vitest";

import {
  E2E_TEST_TIMEOUT_MS,
  PRICING_LINE,
  startApp,
  startHub,
  toAppUrl,
  useProcesses,
  waitForStatus,
} from "./harness.js";

describe("breakpoints under tsx", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("sets a breakpoint on pricing.ts and captures a snapshot at its line with the local variables", async () => {
    const hub = await startHub();
    const app = await startApp({ hubPort: hub.port });
    await waitForStatus(hub.run, "bp-quote", (status) => status.status === "active");

    const response = await fetch(toAppUrl(app.port, "/price?sku=sku-2&quantity=3"));
    const [snapshot] = await hub.run.waitForMessages("snapshot");
    const [top] = snapshot?.stack ?? [];

    expect({
      status: response.status,
      file: top?.file,
      line: top?.line,
      variables: snapshot?.variables,
    }).toEqual({
      status: 200,
      file: expect.stringMatching(/\/examples\/node-basic\/src\/pricing\.ts$/) as unknown,
      line: PRICING_LINE,
      variables: expect.arrayContaining([
        { name: "sku", value: { type: "string", value: "SKU-2", length: 5 } },
        { name: "quantity", value: { type: "number", value: 3 } },
        { name: "unitPrice", value: { type: "number", value: 4.5 } },
        { name: "total", value: { type: "number", value: 13.5 } },
      ]) as unknown,
    });
  });

  it("reports pending for a file no loaded script matches", async () => {
    const hub = await startHub({ breakpoints: [{ id: "bp-missing", file: "src/missing.ts", line: 1 }] });
    await startApp({ hubPort: hub.port });

    const status = await waitForStatus(hub.run, "bp-missing");

    expect(status.status).toBe("pending");
  });

  it("reports error for util.ts, which matches both src/a/util.ts and src/b/util.ts", async () => {
    const hub = await startHub({ breakpoints: [{ id: "bp-util", file: "util.ts", line: 5 }] });
    await startApp({ hubPort: hub.port });

    // The first status can be pending while the source maps of both files are read
    const status = await waitForStatus(hub.run, "bp-util", (candidate) => candidate.status !== "pending");

    expect({ status: status.status, message: status.message }).toEqual({
      status: "error",
      message: expect.stringMatching(/several/) as unknown,
    });
  });
});
