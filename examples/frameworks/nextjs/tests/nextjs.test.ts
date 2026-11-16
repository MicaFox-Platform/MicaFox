// The SDK runs in a self-hosted Next.js app, started from instrumentation.ts on the Node.js runtime. `next build`
// (Turbopack, next 16.4.6) bundles each route handler into a `.next/server/chunks/` file whose name does not match
// the breakpoint's, and `.next/server/app/quote/route.js` only loads those chunks, so the debugger finds route.ts by
// searching the maps of the app's chunks (docs/architecture/sdk/debugger.md, applying breakpoints). Next.js loads a
// route's chunks on its first request, so that request runs before the breakpoint is set.

import {
  E2E_TEST_TIMEOUT_MS,
  fetchInARow,
  fetchUntilSnapshot,
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

import { NEXTJS_APP } from "./app.js";

const REQUESTS = 20;
const EDGE_LOG = "MicaFox does not run on the Edge runtime: the SDK is not started";

describe("the Next.js app", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("captures the handler's locals at the source line of a bundled route handler once its chunk loads", async () => {
    const hub = await startQuoteHub(NEXTJS_APP);
    const server = await startQuoteApp(NEXTJS_APP, hub.port);
    await hub.run.waitForMessages("breakpointStatus");

    // The first request loads the route's chunk, whose map holds route.ts, unless Next.js loaded it already
    const first = await fetchInARow(toQuoteUrl(server.port), 1);
    await waitForQuoteStatus(hub.run, (status) => status.status === "active");
    const statuses = await fetchInARow(toQuoteUrl(server.port), REQUESTS);
    const snapshot = await fetchUntilSnapshot(toQuoteUrl(server.port), hub.run);
    const [top] = snapshot.stack;

    expect({
      statuses: [...first, ...statuses],
      file: top?.file,
      line: top?.line,
      variables: snapshot.variables,
    }).toEqual({
      statuses: Array.from({ length: REQUESTS + 1 }, () => 200),
      // The handler's own file and line, from the map of the chunk Next.js bundled it into
      file: expect.stringMatching(toQuoteFilePattern(NEXTJS_APP)) as unknown,
      line: findQuoteLine(NEXTJS_APP),
      // `next build` minifies server code: the handler's locals keep the names the minifier gave them, and `total`,
      // used once, is inlined into the response
      variables: expect.arrayContaining([
        { name: expect.any(String) as unknown, value: { type: "string", value: "SKU-2", length: 5 } },
        { name: expect.any(String) as unknown, value: { type: "number", value: 3 } },
        { name: expect.any(String) as unknown, value: { type: "number", value: 4.5 } },
      ]) as unknown,
    });
  });

  it("stops the SDK on SIGTERM", async () => {
    const hub = await startQuoteHub(NEXTJS_APP);
    const server = await startQuoteApp(NEXTJS_APP, hub.port);
    await hub.run.waitForMessages("breakpointStatus");

    const shutdown = await shutDownQuoteApp(NEXTJS_APP, server.run, hub.run);

    expect({
      hellos: hub.run.messages().filter((message) => message.type === "hello").length,
      ...shutdown,
    }).toEqual({ hellos: 1, exit: NEXTJS_APP.exitOnSigterm, stopped: true });
  });

  it("does not start the SDK on the Edge runtime and keeps serving there", async () => {
    const hub = await startQuoteHub(NEXTJS_APP);
    const server = await startQuoteApp(NEXTJS_APP, hub.port);
    await hub.run.waitForMessages("hello");

    const statuses = await fetchInARow(toQuoteUrl(server.port, "/edge"), 1);
    // instrumentation.ts logs on the Edge runtime when the first Edge route runs
    await server.run.waitForLines((line) => line === EDGE_LOG);
    await shutDownQuoteApp(NEXTJS_APP, server.run, hub.run);

    expect({
      statuses,
      hellos: hub.run.messages().filter((message) => message.type === "hello").length,
    }).toEqual({ statuses: [200], hellos: 1 });
  });
});
