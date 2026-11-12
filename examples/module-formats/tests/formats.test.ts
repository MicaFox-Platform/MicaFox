import { describe, expect, it } from "vitest";

import {
  E2E_TEST_TIMEOUT_MS,
  fetchInARow,
  findQuoteLine,
  startApp,
  startHub,
  SUPPORTED_APPS,
  toQuoteUrl,
  toRepositoryPath,
  useProcesses,
  waitForStatus,
} from "./harness.js";

// Twice the 10 snapshots a second one breakpoint captures, so the requests also run past its rate limit
const REQUESTS = 20;

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

describe.each(SUPPORTED_APPS)("the $name app on the built SDK", { timeout: E2E_TEST_TIMEOUT_MS }, (app) => {
  useProcesses();

  it("reports the breakpoint set by its repository path as active", async () => {
    const hub = await startHub(app);
    await startApp(app, hub.port);

    // The first status can be pending while a source map is read
    const status = await waitForStatus(hub.run, (candidate) => candidate.status !== "pending");

    expect(status.status).toBe("active");
  });

  it("captures a snapshot at the source line of quote() and keeps answering HTTP past the rate limit", async () => {
    const hub = await startHub(app);
    const server = await startApp(app, hub.port);
    await waitForStatus(hub.run, (status) => status.status === "active");

    const statuses = await fetchInARow(toQuoteUrl(server.port), REQUESTS);
    const [snapshot] = await hub.run.waitForMessages("snapshot");
    const [top] = snapshot?.stack ?? [];

    expect({ statuses, file: top?.file, line: top?.line, variables: snapshot?.variables }).toEqual({
      statuses: Array.from({ length: REQUESTS }, () => 200),
      // For the tsc apps, the original .ts file and line from the .map beside the compiled file
      file: expect.stringMatching(new RegExp(`/${escapeRegExp(toRepositoryPath(app.quoteSource))}$`)) as unknown,
      line: findQuoteLine(app),
      variables: expect.arrayContaining([
        { name: "sku", value: { type: "string", value: "SKU-2", length: 5 } },
        { name: "quantity", value: { type: "number", value: 3 } },
        { name: "unitPrice", value: { type: "number", value: 4.5 } },
        { name: "total", value: { type: "number", value: 13.5 } },
      ]) as unknown,
    });
  });
});
