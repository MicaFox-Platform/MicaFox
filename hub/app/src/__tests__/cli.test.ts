import type { RunHubProcess } from "@micafox/hub-core";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { runCli, USAGE } from "../cli.js";

interface Fixture {
  proc: RunHubProcess;
  exits: number[];
  stdout: () => string;
  stderr: () => string;
  signal: (name: "SIGTERM" | "SIGINT") => void;
}

// Test mode with a free port and PGlite in memory, as an operator writes the settings
const TEST_MODE_ENV: Record<string, string> = Object.fromEntries(
  ["MICAFOX_TEST_MODE=true", "MICAFOX_DATABASE_URL=pglite:memory", "MICAFOX_HOST=127.0.0.1", "MICAFOX_PORT=0"].map(
    (line): [string, string] => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    },
  ),
);

const createProcess = (env: Record<string, string> = TEST_MODE_ENV): Fixture => {
  const out: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const handlers = new Map<string, () => void>();
  return {
    proc: {
      env,
      stdout: new Writable({
        write(chunk: Buffer, _encoding, done) {
          out.push(chunk.toString());
          done();
        },
      }),
      stderr: {
        write: (text) => {
          errors.push(text);
        },
      },
      on: (signal, listener) => handlers.set(signal, listener),
      exit: (code) => {
        exits.push(code);
      },
    },
    exits,
    stdout: () => out.join(""),
    stderr: () => errors.join(""),
    signal: (name) => {
      handlers.get(name)?.();
    },
  };
};

const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

describe("micafox-hub", () => {
  it("prints the version and the ee edition of the default build with version", async () => {
    const { proc, stdout, exits } = createProcess();

    await runCli(["version"], proc);

    expect(stdout()).toBe(`${VERSION} (ee)\n`);
    expect(exits).toEqual([]);
  });

  it("migrates and exits with 0 with migrate", async () => {
    const { proc, exits, stdout } = createProcess();

    await runCli(["migrate"], proc);

    expect(exits).toEqual([0]);
    expect(stdout()).toContain("db.migrations-done");
  });

  it("serves the hub until SIGTERM, then exits with 0, with start", async () => {
    const { proc, exits, stdout, signal } = createProcess();
    await runCli(["start"], proc);
    await vi.waitFor(() => {
      expect(stdout()).toContain("hub.started");
    });

    signal("SIGTERM");

    await vi.waitFor(() => {
      expect(exits).toEqual([0]);
    });
  });

  it.each([[["reset"]], [["start", "--now"]]])("prints the usage and exits with 2 for %j", async (args) => {
    const { proc, exits, stderr } = createProcess();

    await runCli(args, proc);

    expect(exits).toEqual([2]);
    expect(stderr()).toBe(`Unknown command: ${args.join(" ")}\n\n${USAGE}`);
  });

  it("prints the usage and exits with 2 without a command", async () => {
    const { proc, exits, stderr } = createProcess();

    await runCli([], proc);

    expect(exits).toEqual([2]);
    expect(stderr()).toBe(`No command given\n\n${USAGE}`);
  });
});
