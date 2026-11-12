import { describe, expect, it } from "vitest";

import {
  E2E_TEST_TIMEOUT_MS,
  EXPRESS_APP,
  fetchInARow,
  findQuoteLine,
  NESTJS_APP,
  shutDown,
  startApp,
  startHub,
  toRepositoryPath,
  toUrl,
  useProcesses,
  waitForStatus,
} from "./harness.js";

// Twice the 10 snapshots a second one breakpoint captures, so the requests also run past its rate limit
const REQUESTS = 20;

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

describe.each([EXPRESS_APP, NESTJS_APP])("the $name app", { timeout: E2E_TEST_TIMEOUT_MS }, (app) => {
  useProcesses();

  it("captures the request's locals at the source line of its route handler and keeps answering HTTP", async () => {
    const hub = await startHub(app);
    const server = await startApp(app, hub.port);
    // The first status can be pending while a source map is read
    await waitForStatus(hub.run, (status) => status.status === "active");

    const statuses = await fetchInARow(toUrl(server.port), REQUESTS);
    const [snapshot] = await hub.run.waitForMessages("snapshot");
    const [top] = snapshot?.stack ?? [];

    expect({
      statuses,
      file: top?.file,
      line: top?.line,
      truncated: snapshot?.truncated,
      variables: snapshot?.variables,
    }).toEqual({
      statuses: Array.from({ length: REQUESTS }, () => 200),
      // For NestJS, the original .ts file and line from the .map the Nest CLI wrote beside the compiled file
      file: expect.stringMatching(new RegExp(`/${escapeRegExp(toRepositoryPath(app.quoteSource))}$`)) as unknown,
      line: findQuoteLine(app),
      // Within the 10 ms of a pause, so every variable was read
      truncated: undefined,
      variables: expect.arrayContaining([
        { name: "sku", value: { type: "string", value: "SKU-2", length: 5 } },
        { name: "quantity", value: { type: "number", value: 3 } },
        { name: "unitPrice", value: { type: "number", value: 4.5 } },
        { name: "total", value: { type: "number", value: 13.5 } },
      ]) as unknown,
    });
  });

  it("stops the SDK on SIGTERM and sends the snapshot taken just before", async () => {
    const hub = await startHub(app);
    const server = await startApp(app, hub.port);
    await waitForStatus(hub.run, (status) => status.status === "active");
    await fetchInARow(toUrl(server.port), 1);

    const shutdown = await shutDown(app, server.run, hub.run);

    expect({
      ...shutdown,
      snapshots: hub.run.messages().filter((message) => message.type === "snapshot").length,
    }).toEqual({ exit: app.exitOnSigterm, stopped: true, snapshots: 1 });
  });
});
