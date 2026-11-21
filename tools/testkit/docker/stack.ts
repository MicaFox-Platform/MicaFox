// The compose stack of the container tests: sandbox/compose.yaml with compose.test.yaml on top, under its own project
// name, so removing it never removes a stack of `pnpm docker:up`; both publish the same ports, so one runs at a time.
// Every function runs the docker CLI, waits for it and throws when it fails, so a broken command never reads as a pass.

import { spawnSync } from "node:child_process";
import path from "node:path";

import { toHubBreakpoints } from "./apps.js";
import { ChildProcessRun } from "../src/child-process-run.js";
import { createEnvironment } from "../src/processes.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const PROJECT = "micafox-docker-test";
const COMPOSE_ARGS = [
  "compose",
  "--project-name",
  PROJECT,
  "--file",
  path.join(ROOT, "sandbox", "compose.yaml"),
  "--file",
  path.join(import.meta.dirname, "compose.test.yaml"),
];

/** The environment of every docker command: compose.test.yaml requires HUB_BREAKPOINTS, for `down` and `logs` too. */
const createDockerEnvironment = (): Record<string, string> => {
  const env = createEnvironment();
  env.HUB_BREAKPOINTS = toHubBreakpoints();
  return env;
};

type Output = "inherit" | "pipe";

/** Runs `docker <args>`; resolves with its stdout, or throws when it exits with another code than 0. */
const runDocker = (args: readonly string[], output: Output = "pipe"): string => {
  const result = spawnSync("docker", args, {
    cwd: ROOT,
    env: createDockerEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", output, output],
  });
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 7).join(" ")} … failed (${String(result.status ?? result.signal)}):
${result.stderr}`);
  }

  return result.stdout;
};

const runCompose = (args: readonly string[], output: Output = "pipe"): string =>
  runDocker([...COMPOSE_ARGS, ...args], output);

/** Builds the images and starts the stack; returns once every container is healthy, or throws. */
export const startStack = (): void => {
  // The build log goes to the terminal: a slow or failed build is read there
  runCompose(["up", "--build", "--detach", "--wait", "--wait-timeout", "240"], "inherit");
};

/** Removes the stack's containers, networks and volumes; the images stay, as the build cache of the next run. */
export const removeStack = (): void => {
  runCompose(["down", "--volumes", "--remove-orphans", "--timeout", "1"], "inherit");
};

/** Follows the fake hub's output from its start: every message it received, one JSON line each. */
export const followHub = (): ChildProcessRun =>
  new ChildProcessRun({
    name: "fake hub container",
    command: "docker",
    args: [...COMPOSE_ARGS, "logs", "--follow", "--no-log-prefix", "--no-color", "hub"],
    env: createDockerEnvironment(),
    cwd: ROOT,
  });

/** How a stopped container ended. */
export interface StoppedContainer {
  readonly status: string;
  readonly exitCode: number;
  readonly isOomKilled: boolean;
}

const STATE = /^(\w+) (\d+) (true|false)$/;

/** Sends SIGTERM to `service`'s PID 1, as `docker stop` does, and returns how it ended; SIGKILL after 10 s. */
export const stopService = (service: string): StoppedContainer => {
  runCompose(["stop", "--timeout", "10", service]);
  const id = runCompose(["ps", "--all", "--quiet", service]).trim();
  const state = runDocker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}", id]);
  const [, status = "", exitCode = "", isOomKilled = ""] = STATE.exec(state.trim()) ?? [];
  if (status === "") {
    throw new Error(`docker inspect of ${service} printed no state: ${state}`);
  }

  return { status, exitCode: Number(exitCode), isOomKilled: isOomKilled === "true" };
};

/** Every line `service` printed so far, stdout and stderr, in order. */
export const readServiceLines = (service: string): string[] =>
  runCompose(["logs", "--no-log-prefix", "--no-color", service]).split("\n");
