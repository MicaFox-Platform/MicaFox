import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, logRoute, parseRecords, runServer, type StdoutRecord } from "./run-server.js";

const lineRoute = (message: string): string => logRoute({ level: "warn", message });

const recorded = (message: string): StdoutRecord => ({
  level: "warn",
  message: `[micafox] e2e: ${message}`,
  context: { component: "e2e" },
});

// One more line than the queue holds, and what the run writes for it; built here so the test stays free of loops
const OVERFLOW_COUNT = 101;
const OVERFLOW_NUMBERS = Array.from({ length: OVERFLOW_COUNT }, (_, index) => index + 1);
const OVERFLOWING_LINES = OVERFLOW_NUMBERS.map((number) => lineRoute(`line ${String(number)}`));
const OVERFLOW_OUTPUT: StdoutRecord[] = [
  { step: "/hold" },
  ...OVERFLOW_NUMBERS.map(() => ({ step: "/log" })),
  { step: "/release" },
  // line 1 is the oldest, so it is the one dropped
  ...OVERFLOW_NUMBERS.slice(1).map((number) => recorded(`line ${String(number)}`)),
  recorded("log lines dropped while the thread was paused: 1"),
  { step: "/close" },
];

describe("pause hold in a running server", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  it("writes a line logged during a hold after release(), before the next request", async () => {
    const run = await runServer({ logger: "recording" }, ["/hold", lineRoute("breakpoint hit"), "/release"]);

    expect(parseRecords(run.stdout)).toEqual([
      { step: "/hold" },
      { step: "/log" },
      { step: "/release" },
      recorded("breakpoint hit"),
      { step: "/close" },
    ]);
  });

  it("keeps held lines through flush() until release()", async () => {
    const run = await runServer({ logger: "recording" }, ["/hold", lineRoute("breakpoint hit"), "/flush", "/release"]);

    expect(parseRecords(run.stdout)).toEqual([
      { step: "/hold" },
      { step: "/log" },
      { step: "/flush" },
      { step: "/release" },
      recorded("breakpoint hit"),
      { step: "/close" },
    ]);
  });

  it("drops the oldest line beyond 100 held lines and warns how many were dropped", async () => {
    const run = await runServer({ logger: "recording" }, ["/hold", ...OVERFLOWING_LINES, "/release"]);

    expect(parseRecords(run.stdout)).toEqual(OVERFLOW_OUTPUT);
  });
});
