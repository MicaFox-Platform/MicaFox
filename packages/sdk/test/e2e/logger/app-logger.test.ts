import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, logRoute, parseRecords, micafoxLines, runServer } from "./run-server.js";

const FAILED_REQUEST = logRoute({
  level: "error",
  message: "hub unreachable",
  breakpointId: "bp-1",
  errorCode: "ECONNREFUSED",
});

describe("app logger in a running server", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  it("prints only the message to the default console", async () => {
    const run = await runServer({}, [FAILED_REQUEST]);

    expect(micafoxLines(run.stderr)).toEqual(["[micafox] e2e: hub unreachable"]);
  });

  it("passes the message and a plain context to the app's logger", async () => {
    const run = await runServer({ logger: "recording" }, [FAILED_REQUEST]);

    // toMatchObject leaves out the stack, whose text depends on the machine
    expect(parseRecords(run.stdout)).toMatchObject([
      { step: "/log" },
      {
        level: "error",
        message: "[micafox] e2e: hub unreachable",
        context: {
          component: "e2e",
          breakpointId: "bp-1",
          error: { name: "E2eError", message: "request failed", code: "ECONNREFUSED" },
        },
      },
      { step: "/close" },
    ]);
  });

  it("keeps the server running and exits cleanly when the app's logger throws", async () => {
    const run = await runServer({ logger: "throwing" }, [FAILED_REQUEST, FAILED_REQUEST]);

    expect({ exitCode: run.exitCode, sdkLines: micafoxLines(run.stderr) }).toEqual({ exitCode: 0, sdkLines: [] });
  });

  it("raises no unhandled rejection when the app's logger returns a rejected promise", async () => {
    const run = await runServer({ logger: "rejecting" }, [FAILED_REQUEST, FAILED_REQUEST]);

    expect({ exitCode: run.exitCode, sdkLines: micafoxLines(run.stderr) }).toEqual({ exitCode: 0, sdkLines: [] });
  });

  it("warns on the default console and writes there when the logger lacks a method", async () => {
    const run = await runServer({ logger: "invalid" }, [FAILED_REQUEST]);

    expect(micafoxLines(run.stderr)).toEqual([
      "[micafox] e2e: logger must be an object with debug, info, warn and error methods; using console",
      "[micafox] e2e: hub unreachable",
    ]);
  });
});
