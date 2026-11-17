// One run of one mode: a fresh fake hub and app, a closed-loop phase for the most the app serves, then a fixed-rate
// phase for latency, CPU and snapshots. A run that is not what its mode claims, such as a hot breakpoint that never
// became active or a debugger that stopped itself, throws instead of returning a number.

import { setTimeout as delay } from "node:timers/promises";

import { execIn, readLogLines, removeContainer, runContainer, startContainer, toContainerName } from "./containers.js";
import type { LoadResult } from "./load.js";
import { countHubEvents, isActive, parseCpuUsageUsec, parseRssPeakMib, type RunResult } from "./measure.js";
import type { Mode } from "./modes.js";

/** The images a run starts. */
export interface Images {
  readonly app: string;
  readonly hub: string;
}

/** How hard and how long a run loads the app. */
export interface Load {
  /** Connections of the closed loop: requests always in flight. */
  readonly connections: number;
  /** Connections at the fixed rate: far more than the requests in flight, so none waits for a free one. */
  readonly fixedRateConnections: number;
  /** Worker threads of the load generator, one per vCPU it gets. */
  readonly threads: number;
  readonly ratePerSecond: number;
  readonly warmUpMs: number;
  readonly measureMs: number;
}

/** The app's limits; the hub and the load generator get vCPUs of their own. */
export const APP_LIMITS = { cpus: 1, memory: "512m" } as const;
const CPUSETS = { app: "1", hub: "2", load: "3-6" } as const;
const APP_URL = `http://${toContainerName("app")}:3000/price?sku=SKU-2&quantity=3`;
// Past this share of its vCPUs the load generator, not the app, could be the limit
const MAX_LOAD_CPU_SHARE = 0.8;
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 200;
// What a load run may take beyond its duration: starting its container and threads
const LOAD_MARGIN_MS = 60_000;
const HEALTH_CHECK = [
  "node",
  "-e",
  "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
];

const waitUntil = async (what: string, isDone: () => boolean): Promise<void> => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!isDone()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(POLL_MS);
  }
};

const isHealthy = (): boolean => {
  try {
    execIn("app", HEALTH_CHECK);
    return true;
  } catch {
    // Not listening yet
    return false;
  }
};

interface LoadPhase {
  readonly durationMs: number;
  readonly connections: number;
  readonly threads: number;
  readonly ratePerSecond?: number;
}

const runLoad = (hubImage: string, phase: LoadPhase): LoadResult => {
  const output = runContainer({
    name: "load",
    image: hubImage,
    cpuset: CPUSETS.load,
    env: [
      ["LOAD_URL", APP_URL],
      ["LOAD_DURATION_MS", String(phase.durationMs)],
      ["LOAD_CONNECTIONS", String(phase.connections)],
      ["LOAD_THREADS", String(phase.threads)],
      ...(phase.ratePerSecond === undefined ? [] : [["LOAD_RATE", String(phase.ratePerSecond)] as const]),
    ],
    command: ["node", "--import", "tsx", "bench/load.ts"],
    timeoutMs: phase.durationMs + LOAD_MARGIN_MS,
  });
  // load.ts prints exactly one JSON line of this shape
  const result = JSON.parse(output.trim()) as LoadResult;
  if (result.errors > 0) {
    throw new Error(`${String(result.errors)} requests failed`);
  }
  if (result.cpuMs / (result.durationMs * result.threads) > MAX_LOAD_CPU_SHARE) {
    throw new Error("the load generator used most of its vCPUs: it may be the limit, not the app");
  }

  return result;
};

const readCpuUsec = (): number => parseCpuUsageUsec(execIn("app", ["cat", "/sys/fs/cgroup/cpu.stat"]));

const startStack = async (mode: Mode, images: Images): Promise<void> => {
  startContainer({
    name: "hub",
    image: images.hub,
    cpuset: CPUSETS.hub,
    env: [["HUB_BREAKPOINTS", JSON.stringify(mode.breakpoint === undefined ? [] : [mode.breakpoint])]],
  });
  startContainer({
    name: "app",
    image: images.app,
    cpuset: CPUSETS.app,
    ...APP_LIMITS,
    hasNoLogs: true,
    env: [
      ["MICAFOX_ENABLED", String(mode.isEnabled)],
      ["MICAFOX_HUB_URL", `ws://${toContainerName("hub")}:8787/micafox`],
      ["MICAFOX_SERVICE", "fastify"],
    ],
  });
  await waitUntil("the app to serve", isHealthy);
  if (mode.isEnabled) {
    await waitUntil("the SDK to connect", () => countHubEvents(readLogLines("hub")).hasHello);
  }
  const { breakpoint } = mode;
  if (breakpoint !== undefined) {
    await waitUntil(`${breakpoint.id} to be active`, () => isActive(readLogLines("hub"), breakpoint.id));
  }
};

// Checks the whole run, from the hub's start: warm-up and closed loop included
const checkHub = (mode: Mode, hubLines: readonly string[]): void => {
  const events = countHubEvents(hubLines);
  if (events.hasExpired || events.hasDisconnected) {
    throw new Error("the breakpoint expired or the app left the hub during the run");
  }
  if (events.hasHello !== mode.isEnabled) {
    throw new Error(mode.isEnabled ? "the SDK never connected" : "the SDK connected while it is off");
  }
  if (events.snapshots > 0 !== mode.expectsSnapshots) {
    const expected = mode.expectsSnapshots ? "some" : "none";
    throw new Error(`${mode.label}: ${String(events.snapshots)} snapshots, expected ${expected}`);
  }
};

const measureRun = (mode: Mode, images: Images, load: Load): RunResult & { rateLimited: number } => {
  runLoad(images.hub, { durationMs: load.warmUpMs, connections: load.connections, threads: load.threads });
  const closed = runLoad(images.hub, {
    durationMs: load.measureMs,
    connections: load.connections,
    threads: load.threads,
  });

  const hubLinesBefore = readLogLines("hub").length;
  const cpuBefore = readCpuUsec();
  const fixed = runLoad(images.hub, {
    durationMs: load.measureMs,
    connections: load.fixedRateConnections,
    threads: load.threads,
    ratePerSecond: load.ratePerSecond,
  });
  const cpuMs = (readCpuUsec() - cpuBefore) / 1000;
  const allHubLines = readLogLines("hub");
  checkHub(mode, allHubLines);
  const events = countHubEvents(allHubLines.slice(hubLinesBefore));

  return {
    maxRequestsPerSecond: closed.requestsPerSecond,
    p50Ms: fixed.p50Ms,
    p99Ms: fixed.p99Ms,
    maxMs: fixed.maxMs,
    cpuMsPerSecond: (cpuMs * 1000) / fixed.durationMs,
    rssPeakMib: parseRssPeakMib(execIn("app", ["cat", "/proc/1/status"])),
    snapshotsPerSecond: (events.snapshots * 1000) / fixed.durationMs,
    rateLimited: events.rateLimited,
  };
};

// A failed removal must not hide the error of the run; removeAll() at the end of the benchmark tries again
const removeQuietly = (name: string): void => {
  try {
    removeContainer(name);
  } catch (error) {
    console.error(`could not remove ${name}:`, error);
  }
};

/** Runs `mode` once on fresh containers and removes them afterwards, also after a failure. */
export const runMode = async (mode: Mode, images: Images, load: Load): Promise<RunResult & { rateLimited: number }> => {
  try {
    await startStack(mode, images);
    return measureRun(mode, images, load);
  } finally {
    removeQuietly("app");
    removeQuietly("hub");
  }
};
