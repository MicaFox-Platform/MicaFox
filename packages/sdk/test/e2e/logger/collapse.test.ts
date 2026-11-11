import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, logRoute, parseRecords, runServer } from "./run-server.js";

const REPEATED = logRoute({ level: "warn", message: "snapshot dropped", key: "snapshot-dropped" });

describe("repeat collapsing in a running server", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  it("writes a repeated problem once, then a summary with the count on flush()", async () => {
    const run = await runServer({ logger: "recording" }, [REPEATED, REPEATED, REPEATED, "/flush"]);

    // The summary's message is left out: its seconds come from the real clock of the child process
    expect(parseRecords(run.stdout)).toMatchObject([
      { step: "/log" },
      { level: "warn", message: "[micafox] e2e: snapshot dropped", context: { component: "e2e" } },
      { step: "/log" },
      { step: "/log" },
      { step: "/flush" },
      { level: "warn", context: { component: "e2e", count: 2 } },
      { step: "/close" },
    ]);
  });

  it("names the repeats in the summary's message", async () => {
    const run = await runServer({ logger: "recording" }, [REPEATED, REPEATED, REPEATED, "/flush"]);

    expect(run.stdout.at(-2)).toMatch(/"message":"\[micafox\] e2e: snapshot dropped \(repeated 2 times in \d+ s\)"/);
  });

  it("exits by itself while a collapse window is still open", async () => {
    const run = await runServer({ logger: "recording" }, [REPEATED, REPEATED]);

    expect(run.exitCode).toBe(0);
  });
});
