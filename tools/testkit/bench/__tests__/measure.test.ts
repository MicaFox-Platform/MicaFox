import { describe, expect, it } from "vitest";

import {
  countHubEvents,
  differByRound,
  formatTable,
  isActive,
  parseCpuUsageUsec,
  parseRssPeakMib,
  summarize,
  type RunResult,
} from "../measure.js";

const createRun = (overrides: Partial<RunResult> = {}): RunResult => ({
  maxRequestsPerSecond: 10_000,
  p50Ms: 1.2,
  p99Ms: 4.5,
  maxMs: 12,
  cpuMsPerSecond: 550,
  rssPeakMib: 80,
  snapshotsPerSecond: 0,
  ...overrides,
});

describe("parseCpuUsageUsec", () => {
  it("reads usage_usec from a cgroup v2 cpu.stat", () => {
    const cpuStat = "usage_usec 1234567\nuser_usec 1000000\nsystem_usec 234567\nnr_periods 10\n";

    expect(parseCpuUsageUsec(cpuStat)).toBe(1_234_567);
  });

  it("throws when the file has no usage_usec line", () => {
    expect(() => parseCpuUsageUsec("user_usec 1000\n")).toThrow(/usage_usec/);
  });
});

describe("parseRssPeakMib", () => {
  it("reads VmHWM in MiB from /proc/<pid>/status", () => {
    const status = "Name:\tnode\nVmPeak:\t 1000000 kB\nVmHWM:\t   81920 kB\nVmRSS:\t   70000 kB\n";

    expect(parseRssPeakMib(status)).toBe(80);
  });

  it("throws when the status has no VmHWM line", () => {
    expect(() => parseRssPeakMib("Name:\tnode\n")).toThrow(/VmHWM/);
  });
});

describe("summarize", () => {
  it("gives the middle value of an odd count with the range", () => {
    expect(summarize([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30 });
  });

  it("gives the mean of the middle two of an even count", () => {
    expect(summarize([4, 1, 3, 2])).toEqual({ median: 2.5, min: 1, max: 4 });
  });

  it("throws on no values", () => {
    expect(() => summarize([])).toThrow(/no values/);
  });
});

describe("formatTable", () => {
  it("writes one row per mode with the median and range of each metric", () => {
    const runs = [
      createRun({ maxRequestsPerSecond: 9000, p50Ms: 1.1 }),
      createRun({ maxRequestsPerSecond: 11_000, p50Ms: 1.3 }),
      createRun(),
    ];

    const table = formatTable([{ label: "SDK off", runs }]);

    expect(table.split("\n")).toEqual([
      "| Mode | Max req/s | p50 ms | p99 ms | Max ms | CPU ms/s | RSS MiB | Snapshots/s |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| SDK off | 10,000 (9,000–11,000) | 1.20 (1.10–1.30) | 4.50 (4.50–4.50) | 12.0 (12.0–12.0) | 550 (550–550) | " +
        "80 (80–80) | 0.0 (0.0–0.0) |",
    ]);
  });
});

const statusLine = (breakpointId: string, status: string): string =>
  JSON.stringify({ version: 1, module: "debugger", type: "breakpointStatus", breakpointId, status });
const SNAPSHOT_LINE = JSON.stringify({ version: 1, module: "debugger", type: "snapshot", breakpointId: "bp-hot" });

describe("countHubEvents", () => {
  it("counts snapshots and rateLimited statuses and ignores the hub's own lines", () => {
    const lines = ["listening on port 8787", SNAPSHOT_LINE, statusLine("bp-hot", "rateLimited"), SNAPSHOT_LINE];

    expect(countHubEvents(lines)).toEqual({
      snapshots: 2,
      rateLimited: 1,
      hasExpired: false,
      hasDisconnected: false,
      hasHello: false,
    });
  });

  it("reports an expired breakpoint and a disconnected app", () => {
    const lines = [statusLine("bp-hot", "expired"), "disconnected"];

    expect(countHubEvents(lines)).toMatchObject({ hasExpired: true, hasDisconnected: true });
  });
});

describe("isActive", () => {
  it("is true once the breakpoint reported active", () => {
    expect(isActive([statusLine("bp-hot", "pending"), statusLine("bp-hot", "active")], "bp-hot")).toBe(true);
  });

  it("is false while only another breakpoint is active", () => {
    expect(isActive([statusLine("bp-cold", "active")], "bp-hot")).toBe(false);
  });
});

describe("countHubEvents with nothing to count", () => {
  it("gives zero counts for no lines", () => {
    expect(countHubEvents([])).toEqual({
      snapshots: 0,
      rateLimited: 0,
      hasExpired: false,
      hasDisconnected: false,
      hasHello: false,
    });
  });

  it("skips a line that is cut-off JSON", () => {
    expect(countHubEvents(['{"type":"snapshot"', SNAPSHOT_LINE])).toMatchObject({ snapshots: 1 });
  });
});

describe("countHubEvents and the SDK's connection", () => {
  it("reports a hello as the SDK connected", () => {
    const hello = JSON.stringify({ version: 1, type: "hello", modules: ["debugger"] });

    expect(countHubEvents([hello])).toMatchObject({ hasHello: true });
  });
});

describe("differByRound", () => {
  it("subtracts the baseline's run of the same round from each run", () => {
    const hot = { label: "hot", runs: [createRun({ maxMs: 20 }), createRun({ maxMs: 30 }), createRun({ maxMs: 25 })] };
    const idle = {
      label: "idle",
      runs: [createRun({ maxMs: 12 }), createRun({ maxMs: 28 }), createRun({ maxMs: 15 })],
    };

    expect(differByRound(hot, idle, "maxMs")).toEqual({ median: 8, min: 2, max: 10 });
  });
});
