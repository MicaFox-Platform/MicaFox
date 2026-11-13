// Starts the fake hub of fake-hub/ and reads the breakpoint statuses it prints.

import type { BreakpointStatus } from "@micafox/protocol";
import path from "node:path";

import { readType, type ChildProcessRun } from "./child-process-run.js";
import { createEnvironment, LISTENING, startProcess, type ListeningRun } from "./processes.js";

const KIT_DIR = path.join(import.meta.dirname, "..");
const FAKE_HUB_FILE = path.join(import.meta.dirname, "fake-hub", "main.ts");

/** How the fake hub is started; each field is unset by default, so the hub sets no breakpoints. */
export interface HubOptions {
  /** `PORT`; a free port by default. */
  port?: number;
  /** `HUB_TOKEN`. */
  token?: string;
  /** `HUB_BREAKPOINTS`, as JSON; wins over `breakpointsFile`. */
  breakpoints?: unknown[];
  /** `HUB_BREAKPOINTS_FILE`: the absolute path of a JSON array of breakpoints. */
  breakpointsFile?: string;
}

const HUB_VARIABLES: ReadonlyArray<[keyof HubOptions, string]> = [
  ["port", "PORT"],
  ["token", "HUB_TOKEN"],
  ["breakpointsFile", "HUB_BREAKPOINTS_FILE"],
];

/** Starts the fake hub; resolves once it listens. */
export const startHub = (options: HubOptions = {}): Promise<ListeningRun> => {
  const env = createEnvironment();
  for (const [option, variable] of HUB_VARIABLES) {
    const value = options[option];
    if (value !== undefined) {
      env[variable] = String(value);
    }
  }
  if (options.breakpoints !== undefined) {
    env.HUB_BREAKPOINTS = JSON.stringify(options.breakpoints);
  }
  // The source condition, so the hub reads the protocol's sources and never a stale build; tsx as an import, so no
  // wrapper process can be orphaned. tsx resolves from the kit, its dependency
  const args = ["--conditions=@micafox/source", "--import", "tsx", FAKE_HUB_FILE];
  return startProcess({ name: "fake hub", args, env, cwd: KIT_DIR, readiness: LISTENING });
};

/** The `breakpointStatus` a line of the fake hub holds; the hub prints every message it receives as one line. */
export const readStatus = (line: string): BreakpointStatus | undefined =>
  readType(line) === "breakpointStatus" ? (JSON.parse(line) as BreakpointStatus) : undefined;

/** Resolves with the first `breakpointStatus` the fake hub printed for `breakpointId` that `isWanted` accepts. */
export const waitForStatus = async (
  hub: ChildProcessRun,
  breakpointId: string,
  isWanted: (status: BreakpointStatus) => boolean = () => true,
): Promise<BreakpointStatus> => {
  const [line = ""] = await hub.waitForLines((candidate) => {
    const status = readStatus(candidate);
    return status?.breakpointId === breakpointId && isWanted(status);
  });
  // readStatus() has accepted the line as a breakpointStatus
  return JSON.parse(line) as BreakpointStatus;
};
