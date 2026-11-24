import { createHub, createSystemClock } from "./hub.js";
import type { Hub, HubOptions } from "./hub.js";
import { ConfigError } from "../config/index.js";
import { FeatureRegistryError } from "../feature/index.js";

/** The parts of `process` that `runHub` uses, so a test can stand in for it. */
export interface RunHubProcess {
  env: Readonly<Record<string, string | undefined>>;
  stdout: NodeJS.WritableStream;
  stderr: { write: (text: string) => unknown };
  on: (signal: "SIGTERM" | "SIGINT", listener: () => void) => unknown;
  exit: (code: number) => unknown;
}

/** What `runHub` takes from the app; the environment and the log stream come from the process. */
export type RunHubOptions = Omit<HubOptions, "env" | "logStream"> & {
  /** Called with the built hub before it listens: the place to add readiness steps and stop hooks. */
  configure?: (hub: Hub) => void;
};

const buildHub = (options: RunHubOptions, proc: RunHubProcess): Hub | undefined => {
  const { configure, ...hubOptions } = options;
  try {
    const hub = createHub({ ...hubOptions, env: proc.env, logStream: proc.stdout });
    configure?.(hub);
    return hub;
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof FeatureRegistryError)) {
      throw error;
    }
    proc.stderr.write(`${error.report()}\n`);
    proc.exit(1);
    return undefined;
  }
};

// Kubernetes kills the pod 30 s after SIGTERM; exiting first keeps the exit code and the last log lines the hub's
export const EXIT_DEADLINE_MS = 30_000;

/**
 * Starts the hub as a process: prints every settings problem and exits with 1, listens for SIGTERM and SIGINT to
 * stop within 30 s and exit with 0, and exits with 1 at once on a second signal or when the hub cannot start or stop.
 * Any other error while building or configuring the hub, which is a bug of the app, rejects the returned promise.
 */
export const runHub = async (options: RunHubOptions, proc: RunHubProcess): Promise<void> => {
  const hub = buildHub(options, proc);
  if (hub === undefined) {
    return;
  }
  // An object, since a flag the closures change would be narrowed to false where it is read
  const state = { isStopping: false };

  // The process must end even when the stop itself breaks or hangs, or Kubernetes waits for the kill
  const stopThenExit = async (hasFailed: boolean): Promise<void> => {
    state.isStopping = true;
    const clock = options.clock ?? createSystemClock();
    const deadline = clock.setTimeout(() => {
      proc.exit(1);
    }, EXIT_DEADLINE_MS);
    deadline.unref();
    try {
      const result = await hub.stop();
      proc.exit(hasFailed || !result.clean ? 1 : 0);
    } catch (error) {
      hub.log.error({ err: error }, "The hub could not stop");
      proc.exit(1);
    } finally {
      clock.clearTimeout(deadline);
    }
  };
  const onSignal = (): void => {
    if (state.isStopping) {
      proc.exit(1);
      return;
    }
    void stopThenExit(false);
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);

  try {
    const running = await hub.start();
    await running.ready;
  } catch (error) {
    // A signal that arrives during the start aborts its steps; the stop it began ends the process
    if (!state.isStopping) {
      hub.log.error({ err: error }, "The hub could not start");
      await stopThenExit(true);
    }
  }
};
