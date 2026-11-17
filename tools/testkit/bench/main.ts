// `pnpm bench`: the SDK's overhead in the Fastify example, in four modes, three rounds each, run in Docker with fixed
// limits. It builds the images, runs every mode once per round in a rotated order, so drift over the run does not
// always fall on the same mode, and prints the Markdown of docs/api/sdk/overview.md#overhead to stdout. Method:
// tools/testkit/README.md#benchmark. Needs `docker` on PATH; `pnpm verify` never runs it.

import os from "node:os";

import { buildImage, createNetwork, findDockerProblem, removeAll, runDocker } from "./containers.js";
import { differByRound, formatSpread, formatTable, type ModeResults, type RunResult } from "./measure.js";
import { createModes, type Mode } from "./modes.js";
import { APP_LIMITS, runMode, type Images, type Load } from "./run.js";

const ROUNDS = 3;
const IMAGES: Images = { app: "micafox-bench-fastify", hub: "micafox-bench-hub" };
// The fixed rate stays below what the app serves in every mode, also when the host runs its vCPU on a slower core (an
// efficiency core of Apple silicon serves about half), so latency is not queueing. At a few ms per request, about 50
// are in flight: 256 connections leave every request a free one
const LOAD: Load = {
  connections: 32,
  fixedRateConnections: 256,
  threads: 4,
  ratePerSecond: 15_000,
  warmUpMs: 10_000,
  measureMs: 20_000,
};

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const runRounds = async (modes: readonly Mode[]): Promise<RunResult[][]> => {
  const runs: RunResult[][] = modes.map(() => []);
  for (let round = 0; round < ROUNDS; round += 1) {
    for (let step = 0; step < modes.length; step += 1) {
      const index = (step + round) % modes.length;
      const mode = modes[index];
      if (mode === undefined) {
        continue;
      }
      log(`round ${String(round + 1)}/${String(ROUNDS)}: ${mode.label}`);
      const { rateLimited, ...result } = await runMode(mode, IMAGES, LOAD);
      log(`  ${JSON.stringify(result)}, rateLimited statuses: ${String(rateLimited)}`);
      runs[index]?.push(result);
    }
  }

  return runs;
};

const describeSetup = (): string => {
  const nodeVersion = runDocker(["run", "--rm", IMAGES.app, "node", "--version"]).trim();
  const engine = runDocker(["info", "--format", "{{.OperatingSystem}}, {{.NCPU}} vCPUs, {{.MemTotal}} bytes"]).trim();
  const [cpu] = os.cpus();
  return [
    `Measured ${new Date().toISOString().slice(0, 10)} on ${cpu?.model ?? "an unknown CPU"} (${os.platform()}), ` +
      `Docker: ${engine}.`,
    `App container: \`--cpus ${String(APP_LIMITS.cpus)}\` pinned to one vCPU, \`--memory ${APP_LIMITS.memory}\`, ` +
      `Node.js ${nodeVersion}. Fixed rate ${String(LOAD.ratePerSecond)} req/s, ` +
      `${String(LOAD.fixedRateConnections)} connections, ${String(LOAD.measureMs / 1000)} s per phase, ` +
      `median of ${String(ROUNDS)} runs (min–max).`,
  ].join("\n");
};

// What the hot breakpoint adds, run by run within each round: estimates against the pause limits, not bounds
const describeHotLine = (results: readonly ModeResults[]): string => {
  const [, idle, , hot] = results;
  if (idle === undefined || hot === undefined) {
    return "";
  }

  const difference = (metric: keyof RunResult): string => formatSpread(differByRound(hot, idle, metric), 1);
  return (
    `Hot line minus no breakpoints, per round: max latency ${difference("maxMs")} ms, ` +
    `CPU ${difference("cpuMsPerSecond")} ms/s, p99 ${difference("p99Ms")} ms.`
  );
};

const main = async (): Promise<void> => {
  removeAll();
  buildImage("fastify", IMAGES.app);
  buildImage("hub", IMAGES.hub);
  createNetwork();
  const modes = createModes();
  const runs = await runRounds(modes);
  const results = modes.map((mode, index) => ({ label: mode.label, runs: runs[index] ?? [] }));
  process.stdout.write(`${describeSetup()}\n\n${formatTable(results)}\n\n${describeHotLine(results)}\n`);
};

// Cleanup must not throw over the error that led to it
const removeQuietly = (): void => {
  try {
    removeAll();
  } catch (error) {
    console.error("could not remove the benchmark's containers:", error);
  }
};

const signal = { isInterrupted: false };
// Every docker call is synchronous, so this runs once the current one returns; the run then fails and cleans up
process.once("SIGINT", () => {
  signal.isInterrupted = true;
});

// Without Docker nothing can run or be cleaned up: one line says so, instead of a failed call and a failed cleanup
const dockerProblem = findDockerProblem();
if (dockerProblem === undefined) {
  try {
    await main();
  } catch (error) {
    // The whole error: a failed docker call keeps its reason in `cause`
    console.error(signal.isInterrupted ? "bench interrupted" : "bench failed:", signal.isInterrupted ? "" : error);
    process.exitCode = signal.isInterrupted ? 130 : 1;
  } finally {
    removeQuietly();
  }
} else {
  console.error(`bench needs Docker: ${dockerProblem}`);
  process.exitCode = 1;
}
