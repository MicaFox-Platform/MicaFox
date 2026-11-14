// The containers of the benchmark, run with the plain docker CLI: no compose, so each run sets its own CPU, memory and
// environment. Every container and the network carry one name prefix, so `removeAll()` finds what an interrupted run
// left. Every function waits for docker and throws when it fails, so a broken command never reads as a measurement.

import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const PREFIX = "micafox-bench";
// The hub prints every snapshot of the hot breakpoint: its log outgrows spawnSync's default of 1 MiB within a run
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
// No docker call but a load run takes longer; a hung one fails the benchmark instead of stopping it for good
const DEFAULT_TIMEOUT_MS = 120_000;

/** The network every container of the benchmark joins; on it, each container is reachable by its full name. */
export const NETWORK = `${PREFIX}-net`;

/** Runs `docker <args>` and returns its stdout; throws with its stderr when it exits with another code than 0. */
export const runDocker = (args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): string => {
  const result = spawnSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    const isMissing = "code" in result.error && result.error.code === "ENOENT";
    throw new Error(
      isMissing ? "docker is not on PATH: install Docker, or add its CLI's folder to PATH" : "docker failed",
      {
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 4).join(" ")} … failed (${String(result.status ?? result.signal)}):
${result.stderr}`);
  }

  return result.stdout;
};

const canRun = (args: readonly string[]): boolean =>
  spawnSync("docker", args, { stdio: "ignore", timeout: DEFAULT_TIMEOUT_MS }).status === 0;

/**
 * What keeps the benchmark from using Docker: no `docker` on PATH, no daemon, or no buildx, which examples/Dockerfile
 * needs for its cache mounts. Undefined when Docker is ready.
 */
export const findDockerProblem = (): string | undefined => {
  const version = spawnSync("docker", ["--version"], { stdio: "ignore", timeout: DEFAULT_TIMEOUT_MS });
  if (version.error !== undefined) {
    return "`docker` is not on PATH; add the folder of your Docker CLI to PATH";
  }
  if (!canRun(["info"])) {
    return "the Docker daemon does not answer; start Docker Desktop, OrbStack or your engine";
  }
  if (!canRun(["buildx", "version"])) {
    return "the buildx plugin is missing; link it into ~/.docker/cli-plugins or install it";
  }

  return undefined;
};

/** Builds `target` of examples/Dockerfile as `tag`, with the build log on the terminal. */
export const buildImage = (target: string, tag: string): void => {
  const result = spawnSync(
    "docker",
    ["build", "--file", "examples/Dockerfile", "--target", target, "--tag", tag, "."],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`docker build of ${target} failed`);
  }
};

/** A name and its value. */
type EnvironmentVariable = readonly [string, string];

/** How one container runs. */
export interface ContainerOptions {
  /** Without the prefix: `app`, `hub`, `load`. */
  readonly name: string;
  readonly image: string;
  /** The vCPUs it may run on, as `--cpuset-cpus` takes them. */
  readonly cpuset: string;
  readonly cpus?: number;
  readonly memory?: string;
  /** Environment variables as name and value. */
  readonly env?: readonly EnvironmentVariable[];
  /** Drops its output: the app's request log would cost dockerd CPU outside the container's limits. */
  readonly hasNoLogs?: boolean;
  readonly command?: readonly string[];
  /** How long `runContainer()` waits for it to end. */
  readonly timeoutMs?: number;
}

/** The full name of a container of the benchmark. */
export const toContainerName = (name: string): string => `${PREFIX}-${name}`;

const toRunArgs = (options: ContainerOptions): string[] => [
  "--name",
  toContainerName(options.name),
  "--network",
  NETWORK,
  "--cpuset-cpus",
  options.cpuset,
  ...(options.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
  ...(options.memory === undefined ? [] : ["--memory", options.memory, "--memory-swap", options.memory]),
  ...(options.hasNoLogs === true ? ["--log-driver", "none"] : []),
  ...(options.env ?? []).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
  options.image,
  ...(options.command ?? []),
];

/** Starts a container in the background. */
export const startContainer = (options: ContainerOptions): void => {
  runDocker(["run", "--detach", ...toRunArgs(options)]);
};

/** Runs a container to its end and returns its stdout; it is removed afterwards. */
export const runContainer = (options: ContainerOptions): string =>
  runDocker(["run", "--rm", ...toRunArgs(options)], options.timeoutMs);

/** Runs `command` inside a running container and returns its stdout. */
export const execIn = (name: string, command: readonly string[]): string =>
  runDocker(["exec", toContainerName(name), ...command]);

/** Every line a container printed so far. */
export const readLogLines = (name: string): string[] =>
  runDocker(["logs", toContainerName(name)])
    .split("\n")
    .filter((line) => line !== "");

/** Removes one container, running or not. */
export const removeContainer = (name: string): void => {
  runDocker(["rm", "--force", "--volumes", toContainerName(name)]);
};

/** Removes every container of the benchmark and its network, also those an interrupted run left. */
export const removeAll = (): void => {
  const ids = runDocker(["ps", "--all", "--quiet", "--filter", `name=^${PREFIX}-`])
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) {
    runDocker(["rm", "--force", "--volumes", ...ids]);
  }
  if (runDocker(["network", "ls", "--quiet", "--filter", `name=^${NETWORK}$`]).trim() !== "") {
    runDocker(["network", "rm", NETWORK]);
  }
};

/** Creates the network of the benchmark. */
export const createNetwork = (): void => {
  runDocker(["network", "create", NETWORK]);
};
