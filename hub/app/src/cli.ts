import type { RunHubProcess } from "@micafox/hub-core";

import type { HubBuild } from "./conditions.js";
import { HUB_INFO, migrateHub, startHub } from "./index.js";

/** What `micafox-hub` prints with an unknown or missing command. */
export const USAGE = `Usage: micafox-hub <command>

Commands:
  start     migrate the database, then serve the hub
  migrate   run the missing migrations and exit
  version   print the version and the build
`;

const EDITIONS: Record<HubBuild, string> = { hub: "ee", "basic-hub": "basic" };

// A command line the hub does not know: exit 2, as shells do for a usage error
const refuse = (proc: RunHubProcess, args: readonly string[]): void => {
  const problem = args.length === 0 ? "No command given" : `Unknown command: ${args.join(" ")}`;
  proc.stderr.write(`${problem}\n\n${USAGE}`);
  proc.exit(2);
};

/**
 * Runs `micafox-hub <command>`: `start` and `migrate` exit as the hub does (0, or 1 on failure), `version` prints
 * `<version> (<basic|ee>)`, and anything else prints the usage and exits with 2.
 */
export const runCli = async (args: readonly string[], proc: RunHubProcess): Promise<void> => {
  const [command] = args;
  if (command === undefined || args.length > 1) {
    refuse(proc, args);
    return;
  }
  switch (command) {
    case "start":
      await startHub(proc);
      return;
    case "migrate":
      await migrateHub(proc);
      return;
    case "version":
      proc.stdout.write(`${HUB_INFO.version} (${EDITIONS[HUB_INFO.build]})\n`);
      return;
    default:
      refuse(proc, args);
  }
};
