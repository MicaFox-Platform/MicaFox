// Starts the processes of a test and waits until each serves; useProcesses() kills and awaits every process a test
// started, so none outlives it.

import { afterEach } from "vitest";

import { ChildProcessRun, type ChildProcessOptions } from "./child-process-run.js";

/** The timeout of each test: two process starts, a reconnect and a few requests fit well within it. */
export const E2E_TEST_TIMEOUT_MS = 10_000;

/** The variables of the test runner's environment a process must not inherit, besides `MICAFOX_*`, `HUB_*` and `PORT`. */
export interface InheritedFilter {
  /** Name prefixes, such as `NEXT_`. */
  readonly prefixes?: readonly string[];
  readonly names?: readonly string[];
}

/**
 * The environment of a process: the test runner's, without the developer's own `MICAFOX_*`, `HUB_*`, `PORT` and the
 * variables of `prefixes` and `names`, since each test sets its own. `PORT` is 0, so the process picks a free port.
 */
export const createEnvironment = ({ prefixes = [], names = [] }: InheritedFilter = {}): Record<string, string> => {
  const droppedPrefixes = ["MICAFOX_", "HUB_", ...prefixes];
  const droppedNames = ["PORT", ...names];
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      !droppedPrefixes.some((prefix) => entry[0].startsWith(prefix)) &&
      !droppedNames.includes(entry[0]),
  );
  const environment = Object.fromEntries(inherited);
  environment.PORT = "0";
  return environment;
};

/** The line a process prints once it serves, and the line that holds its port as the first group. */
export interface Readiness {
  readonly ready: RegExp;
  readonly port: RegExp;
}

/** The fake hub and most apps print `listening on port <port>` once they serve. */
export const LISTENING: Readiness = { ready: /^listening on port (\d+)$/, port: /^listening on port (\d+)$/ };

/** A started process and the port it printed that it listens on. */
export interface ListeningRun {
  readonly run: ChildProcessRun;
  readonly port: number;
}

/** How startProcess() starts a process and tells that it serves. */
export interface StartOptions extends ChildProcessOptions {
  readonly readiness: Readiness;
}

const started = new Set<ChildProcessRun>();

/** Starts a process; resolves once it has printed its ready line, or rejects when it exits first. */
export const startProcess = async ({ readiness, ...options }: StartOptions): Promise<ListeningRun> => {
  const run = new ChildProcessRun(options);
  started.add(run);
  await run.waitForLines((line) => readiness.ready.test(line));
  // The port line comes with or before the ready line
  const portLine = run.lines.find((line) => readiness.port.test(line)) ?? "";
  return { run, port: Number(readiness.port.exec(portLine)?.[1]) };
};

/** Kills every process a test started after the test, and waits until each has exited. */
export const useProcesses = (): void => {
  // A worker that dies before afterEach still takes its processes along; kill() is synchronous, as `exit` needs
  process.once("exit", () => {
    for (const run of started) {
      run.stop("SIGKILL");
    }
  });
  afterEach(async (context) => {
    const runs = [...started];
    started.clear();
    // A timeout reports no output of its own: print what each process said, so a failure in CI can be read
    if (context.task.result?.state === "fail") {
      for (const run of runs) {
        console.error(`${run.name} printed:\n${run.lines.join("\n")}`);
      }
    }
    for (const run of runs) {
      run.stop("SIGKILL");
    }
    await Promise.all(runs.map((run) => run.exited));
  });
};
