// The SDK runs in a self-hosted Next.js app, started from instrumentation.ts on the Node.js runtime, but breakpoints in
// its route handlers are not supported yet: `next build` (Turbopack, next 16.4.6) bundles each handler into a
// `.next/server/chunks/` file whose name does not match the breakpoint's, and `.next/server/app/quote/route.js` only
// loads those chunks and has no source map comment, so the debugger reads no map for `route.ts` (docs/architecture/
// sdk/debugger.md, loading a source map). These tests record that the breakpoint stays `pending`, so a change to it
// shows up here. A change of Next.js or of that rule fails them on purpose; it is not flakiness.

import {
  E2E_TEST_TIMEOUT_MS,
  fetchInARow,
  readStatus,
  shutDownQuoteApp,
  startQuoteApp,
  startQuoteHub,
  toQuoteUrl,
  useProcesses,
} from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { NEXTJS_APP } from "./app.js";

const REQUESTS = 20;
const EDGE_LOG = "MicaFox does not run on the Edge runtime: the SDK is not started";

describe("the Next.js app", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("starts the SDK on the Node.js runtime, keeps a route-handler breakpoint pending and stops it on SIGTERM", async () => {
    const hub = await startQuoteHub(NEXTJS_APP);
    const server = await startQuoteApp(NEXTJS_APP, hub.port);
    await hub.run.waitForMessages("breakpointStatus");

    const statuses = await fetchInARow(toQuoteUrl(server.port), REQUESTS);
    const shutdown = await shutDownQuoteApp(NEXTJS_APP, server.run, hub.run);
    const messages = hub.run.messages();

    expect({
      statuses,
      breakpointStatuses: hub.run.lines.flatMap((line) => readStatus(line)?.status ?? []),
      snapshots: messages.filter((message) => message.type === "snapshot"),
      hellos: messages.filter((message) => message.type === "hello").length,
      ...shutdown,
    }).toEqual({
      statuses: Array.from({ length: REQUESTS }, () => 200),
      breakpointStatuses: ["pending"],
      snapshots: [],
      hellos: 1,
      exit: NEXTJS_APP.exitOnSigterm,
      stopped: true,
    });
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
