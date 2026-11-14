// The benchmark's load generator, run inside a container of the hub image next to the app (`node --import tsx
// bench/load.ts`). It sends GET requests to LOAD_URL over keep-alive connections for LOAD_DURATION_MS, from
// LOAD_THREADS worker threads, since one Node thread sends fewer requests than one vCPU of the app serves, and prints
// one JSON line: the requests answered, their latency and its own CPU time, so the benchmark can tell it was not the
// limit.
// - LOAD_RATE unset: closed loop, LOAD_CONNECTIONS requests always in flight; it measures the most the app serves.
// - LOAD_RATE set: open loop at that many requests per second; latency counts from when each request was due, so a
//   slow app does not hide its delay by slowing the load down (coordinated omission).

import { Agent, get } from "node:http";
import { createHistogram, performance } from "node:perf_hooks";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const NS_PER_MS = 1e6;
const TICK_MS = 1;
// A request still unanswered after this counts as failed, so an app that stalls fails the run instead of hanging it
const REQUEST_TIMEOUT_MS = 10_000;

/** What one load run prints. */
export interface LoadResult {
  readonly requests: number;
  /** The sum of every thread's answered requests over its own send window. */
  readonly requestsPerSecond: number;
  readonly errors: number;
  /** The longest send window of a thread, from its first request to its last answer; thread start-up not included. */
  readonly durationMs: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** CPU time of the whole generator, every thread included. */
  readonly cpuMs: number;
  readonly threads: number;
}

/** One thread's share of the load. */
interface Share {
  readonly url: string;
  readonly connections: number;
  readonly ratePerSecond?: number;
  readonly durationMs: number;
}

/** The time a thread sends in, on its own performance.now() clock. */
interface Window {
  readonly startAt: number;
  readonly endAt: number;
}

/** What a thread reports: its errors, its send window and the latency of every answered request, in ms. */
interface ShareResult {
  readonly errors: number;
  readonly windowMs: number;
  readonly latenciesMs: Float64Array;
}

interface LoadState {
  readonly agent: Agent;
  readonly url: string;
  readonly latenciesMs: number[];
  errors: number;
}

const readNumber = (name: string): number | undefined => {
  const value = process.env[name] ?? "";
  return value === "" ? undefined : Number(value);
};

// Resolves when the response is read to its end; latency counts from `dueAt`, a performance.now() time
const sendRequest = (state: LoadState, dueAt: number): Promise<void> =>
  new Promise((resolve) => {
    const done = (isError: boolean): void => {
      if (isError) {
        state.errors += 1;
      } else {
        state.latenciesMs.push(performance.now() - dueAt);
      }
      resolve();
    };
    const request = get(state.url, { agent: state.agent, timeout: REQUEST_TIMEOUT_MS }, (response) => {
      response.resume();
      response.on("end", () => {
        done(response.statusCode !== 200);
      });
      response.on("error", () => {
        done(true);
      });
    });
    request.on("timeout", () => {
      request.destroy();
    });
    request.on("error", () => {
      done(true);
    });
  });

const runClosedLoop = async (state: LoadState, connections: number, { endAt }: Window): Promise<void> => {
  const worker = async (): Promise<void> => {
    while (performance.now() < endAt) {
      await sendRequest(state, performance.now());
    }
  };
  await Promise.all(Array.from({ length: connections }, worker));
};

const runOpenLoop = async (state: LoadState, ratePerSecond: number, { startAt, endAt }: Window): Promise<void> => {
  const intervalMs = 1000 / ratePerSecond;
  const inFlight = new Set<Promise<void>>();
  let sent = 0;
  while (performance.now() < endAt) {
    const due = Math.floor((performance.now() - startAt) / intervalMs);
    for (; sent < due; sent += 1) {
      const request = sendRequest(state, startAt + sent * intervalMs);
      inFlight.add(request);
      void request.then(() => inFlight.delete(request));
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  await Promise.all(inFlight);
};

// A worker thread runs its share from its own start
const runShare = async (share: Share): Promise<ShareResult> => {
  const state: LoadState = {
    agent: new Agent({ keepAlive: true, maxSockets: share.connections }),
    url: share.url,
    latenciesMs: [],
    errors: 0,
  };
  const startAt = performance.now();
  const sendWindow = { startAt, endAt: startAt + share.durationMs };
  await (share.ratePerSecond === undefined
    ? runClosedLoop(state, share.connections, sendWindow)
    : runOpenLoop(state, share.ratePerSecond, sendWindow));
  const windowMs = performance.now() - startAt;
  state.agent.destroy();
  return { errors: state.errors, windowMs, latenciesMs: Float64Array.from(state.latenciesMs) };
};

const startShare = (share: Share): Promise<ShareResult> =>
  new Promise((resolve, reject) => {
    // The worker inherits `--import tsx` from this process's execArgv
    const worker = new Worker(new URL(import.meta.url), { workerData: share });
    // The worker posts exactly one ShareResult
    worker.once("message", (result: ShareResult) => {
      resolve(result);
    });
    worker.once("error", reject);
    // A worker that failed exits without posting; a settled promise ignores this
    worker.once("exit", (code) => {
      reject(new Error(`a load thread exited with code ${String(code)}`));
    });
  });

const summarizeShares = (results: readonly ShareResult[], cpuMs: number): LoadResult => {
  const histogram = createHistogram();
  for (const { latenciesMs } of results) {
    for (const latencyMs of latenciesMs) {
      histogram.record(Math.max(1, Math.round(latencyMs * NS_PER_MS)));
    }
  }
  return {
    requests: histogram.count,
    requestsPerSecond: results.reduce((sum, result) => sum + (result.latenciesMs.length * 1000) / result.windowMs, 0),
    errors: results.reduce((sum, result) => sum + result.errors, 0),
    durationMs: Math.max(...results.map((result) => result.windowMs)),
    p50Ms: histogram.percentile(50) / NS_PER_MS,
    p99Ms: histogram.percentile(99) / NS_PER_MS,
    maxMs: histogram.max / NS_PER_MS,
    cpuMs,
    threads: results.length,
  };
};

const main = async (): Promise<void> => {
  const url = process.env.LOAD_URL ?? "";
  const durationMs = readNumber("LOAD_DURATION_MS") ?? 0;
  const threads = readNumber("LOAD_THREADS") ?? 1;
  const connections = readNumber("LOAD_CONNECTIONS") ?? threads;
  const rate = readNumber("LOAD_RATE");
  if (url === "" || durationMs <= 0) {
    throw new Error("set LOAD_URL and LOAD_DURATION_MS");
  }

  const cpuBefore = process.cpuUsage();
  const share: Share = {
    url,
    durationMs,
    connections: Math.ceil(connections / threads),
    ...(rate === undefined ? {} : { ratePerSecond: rate / threads }),
  };
  const results = await Promise.all(Array.from({ length: threads }, () => startShare(share)));
  const cpu = process.cpuUsage(cpuBefore);
  const result = summarizeShares(results, (cpu.user + cpu.system) / 1000);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const runWorker = async (): Promise<void> => {
  // main() passes a Share as workerData
  const result = await runShare(workerData as Share);
  parentPort?.postMessage(result);
};

(isMainThread ? main() : runWorker()).catch((error: unknown) => {
  console.error("load failed:", error instanceof Error ? error.message : error);
  // Also ends a worker thread with code 1, which its main thread reports
  process.exit(1);
});
