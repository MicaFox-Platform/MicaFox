import {
  E2E_TEST_TIMEOUT_MS,
  fetchInARow,
  fetchUntilCompleteSnapshot,
  findQuoteLine,
  shutDownQuoteApp,
  startQuoteApp,
  startQuoteHub,
  toQuoteFilePattern,
  toQuoteUrl,
  useProcesses,
  waitForQuoteStatus,
} from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { NESTJS_APP } from "./app.js";

// Twice the 10 snapshots a second one breakpoint captures, so the requests also run past its rate limit
const REQUESTS = 20;

describe("the NestJS app", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("captures the request's locals at the source line of its route handler and keeps answering HTTP", async () => {
    const hub = await startQuoteHub(NESTJS_APP);
    const server = await startQuoteApp(NESTJS_APP, hub.port);
    // The first status can be pending while a source map is read
    await waitForQuoteStatus(hub.run, (status) => status.status === "active");

    const statuses = await fetchInARow(toQuoteUrl(server.port), REQUESTS);
    const snapshot = await fetchUntilCompleteSnapshot(toQuoteUrl(server.port), hub.run);
    const [top] = snapshot.stack;

    expect({
      statuses,
      file: top?.file,
      line: top?.line,
      variables: snapshot.variables,
    }).toEqual({
      statuses: Array.from({ length: REQUESTS }, () => 200),
      // For NestJS, the original .ts file and line from the .map the Nest CLI wrote beside the compiled file
      file: expect.stringMatching(toQuoteFilePattern(NESTJS_APP)) as unknown,
      line: findQuoteLine(NESTJS_APP),
      variables: expect.arrayContaining([
        { name: "sku", value: { type: "string", value: "SKU-2", length: 5 } },
        { name: "quantity", value: { type: "number", value: 3 } },
        { name: "unitPrice", value: { type: "number", value: 4.5 } },
        { name: "total", value: { type: "number", value: 13.5 } },
      ]) as unknown,
    });
  });

  it("stops the SDK on SIGTERM and sends the snapshot taken just before", async () => {
    const hub = await startQuoteHub(NESTJS_APP);
    const server = await startQuoteApp(NESTJS_APP, hub.port);
    await waitForQuoteStatus(hub.run, (status) => status.status === "active");
    await fetchInARow(toQuoteUrl(server.port), 1);

    const shutdown = await shutDownQuoteApp(NESTJS_APP, server.run, hub.run);

    expect({
      ...shutdown,
      snapshots: hub.run.messages().filter((message) => message.type === "snapshot").length,
    }).toEqual({ exit: NESTJS_APP.exitOnSigterm, stopped: true, snapshots: 1 });
  });
});
