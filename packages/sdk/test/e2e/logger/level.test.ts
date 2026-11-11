import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, logRoute, micafoxLines, runServer, type ServerRun } from "./run-server.js";

// The default console writes debug and info to stdout, warn and error to stderr; stdout also carries the step marks
const sdkLines = ({ stdout, stderr }: ServerRun): { stdout: string[]; stderr: string[] } => ({
  stdout: micafoxLines(stdout),
  stderr: micafoxLines(stderr),
});

const EVERY_LEVEL = [
  logRoute({ level: "debug", message: "debug line" }),
  logRoute({ level: "info", message: "info line" }),
  logRoute({ level: "warn", message: "warn line" }),
  logRoute({ level: "error", message: "error line" }),
];

describe("logger level in a running server", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  it("writes lines at or above the logLevel option and drops the ones below", async () => {
    const run = await runServer({ logLevel: "info" }, EVERY_LEVEL);

    expect(sdkLines(run)).toEqual({
      stdout: ["[micafox] e2e: info line"],
      stderr: ["[micafox] e2e: warn line", "[micafox] e2e: error line"],
    });
  });

  it("uses MICAFOX_LOG_LEVEL when no logLevel option is given", async () => {
    const run = await runServer({ envLogLevel: "debug" }, EVERY_LEVEL);

    expect(sdkLines(run)).toEqual({
      stdout: ["[micafox] e2e: debug line", "[micafox] e2e: info line"],
      stderr: ["[micafox] e2e: warn line", "[micafox] e2e: error line"],
    });
  });

  it("prefers the logLevel option over MICAFOX_LOG_LEVEL", async () => {
    const run = await runServer({ logLevel: "error", envLogLevel: "debug" }, EVERY_LEVEL);

    expect(sdkLines(run)).toEqual({ stdout: [], stderr: ["[micafox] e2e: error line"] });
  });

  it("uses warn when MICAFOX_LOG_LEVEL is empty", async () => {
    const run = await runServer({ envLogLevel: "" }, EVERY_LEVEL);

    expect(sdkLines(run)).toEqual({ stdout: [], stderr: ["[micafox] e2e: warn line", "[micafox] e2e: error line"] });
  });

  it("warns once and uses warn when MICAFOX_LOG_LEVEL is invalid", async () => {
    const run = await runServer({ envLogLevel: "DEBUG" }, EVERY_LEVEL);

    expect(sdkLines(run)).toEqual({
      stdout: [],
      stderr: [
        "[micafox] e2e: MICAFOX_LOG_LEVEL must be one of debug, info, warn, error or silent; using warn",
        "[micafox] e2e: warn line",
        "[micafox] e2e: error line",
      ],
    });
  });

  it("warns and uses warn when the logLevel option is invalid", async () => {
    const run = await runServer({ logLevel: "verbose" }, EVERY_LEVEL);

    expect(sdkLines(run)).toEqual({
      stdout: [],
      stderr: [
        "[micafox] e2e: logLevel must be one of debug, info, warn, error or silent; using warn",
        "[micafox] e2e: warn line",
        "[micafox] e2e: error line",
      ],
    });
  });

  it("writes nothing at silent", async () => {
    const run = await runServer({ logLevel: "silent" }, EVERY_LEVEL);

    expect(sdkLines(run)).toEqual({ stdout: [], stderr: [] });
  });
});
