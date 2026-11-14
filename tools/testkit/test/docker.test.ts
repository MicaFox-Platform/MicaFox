// The Docker setup of the examples, checked without Docker against the files it must agree with: compose.yaml against
// the Dockerfile's targets, the ports of examples/README.md and the .env.example files, the Dockerfile's commands
// against the apps' start scripts and its paths against the hub's breakpoints. The container tests build the images.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

import { createEnvironment, E2E_TEST_TIMEOUT_MS } from "../src/processes.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const KIT_DIR = path.join(import.meta.dirname, "..");
const FORMATS_START = /^start:(.+)$/;

interface Stage {
  readonly from: string;
  command: string[];
}

const readText = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");
const readScripts = (directory: string): Record<string, string> =>
  (JSON.parse(readText(`${directory}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {};

const dockerfile = readText("examples/Dockerfile");
const compose = readText("examples/compose.yaml");
const hubEnvironment = parseEnv(readText("tools/testkit/.env.example"));
const hubPort = Number(hubEnvironment.PORT);

/** The stages of the Dockerfile with the command they run: `CMD ["node", "src/server.js"]` is `node src/server.js`. */
const readStages = (): Map<string, Stage> => {
  const stages = new Map<string, Stage>();
  let current: Stage | undefined;
  for (const line of dockerfile.split("\n")) {
    const stage = /^FROM (\S+) AS (\S+)$/.exec(line);
    if (stage?.[1] !== undefined && stage[2] !== undefined) {
      current = { from: stage[1], command: [] };
      stages.set(stage[2], current);
    }
    const command = /^CMD (\[.*\])$/.exec(line);
    if (command?.[1] !== undefined && current !== undefined) {
      current.command = JSON.parse(command[1]) as string[];
    }
  }
  return stages;
};

const stages = readStages();
const appStages = [...stages.entries()].filter(([, stage]) => stage.command.length > 0);
// The services of compose.yaml: the Dockerfile target each builds and the port it publishes
const services = [...compose.matchAll(/^ {2}(\S+):\n(?:(?: {4}.*)?\n)*?/gm)].flatMap((match) => {
  const body = compose.slice(match.index + match[0].length).split(/^ {2}\S/m)[0] ?? "";
  const target = /^ {6}target: (\S+)$/m.exec(body)?.[1];
  const port = /"127\.0\.0\.1:(\d+):(\d+)"/.exec(body);
  return target === undefined || port === null ? [] : [{ target, published: port[1], inner: port[2] }];
});
/** The first stage named `runtime` that `name` is built on, or the image it starts from when there is none. */
const findRuntime = (name: string): string => {
  const from = stages.get(name)?.from;
  return name === "runtime" || from === undefined ? name : findRuntime(from);
};
const appPorts = services.map((service) => Number(service.published)).filter((port) => port !== hubPort);

describe("examples/compose.yaml", () => {
  it("builds one service from each app's target of the Dockerfile", () => {
    expect(services.map((service) => service.target).sort()).toEqual(appStages.map(([name]) => name).sort());
  });

  it("publishes each port as the same port, on the host's loopback only", () => {
    expect(services.filter((service) => service.published !== service.inner)).toEqual([]);
    expect(compose.match(/^ {6}- "/gm)).toHaveLength(services.length);
  });

  it("publishes the hub's port and the port of every app in examples/README.md", () => {
    const readme = readText("examples/README.md");

    expect(services.map((service) => Number(service.published))).toContain(hubPort);
    expect(appPorts.filter((port) => !readme.includes(`| \`${String(port)}\` |`))).toEqual([]);
  });

  it("publishes the port each app's .env.example or formats start script sets", () => {
    const formatsDefaults = Object.entries(readScripts("examples/formats")).flatMap(([name, script]) => {
      const match = /PORT=\$\{PORT:-(\d+)\}/.exec(script);
      return FORMATS_START.test(name) && match?.[1] !== undefined ? [Number(match[1])] : [];
    });
    const frameworkPorts = ["fastify", "express", "nestjs", "nextjs"].map((name) =>
      Number(parseEnv(readText(`examples/frameworks/${name}/.env.example`)).PORT),
    );

    expect([...frameworkPorts, ...formatsDefaults].sort()).toEqual([...appPorts].sort());
  });

  it("points the apps at the hub's service on the port of the hub's .env.example", () => {
    expect(compose).toContain(`MICAFOX_HUB_URL: ws://hub:${String(hubPort)}/micafox`);
  });
});

describe("examples/Dockerfile", () => {
  it("runs every app as the non-root node user", () => {
    expect(new Set(appStages.map(([name]) => findRuntime(name)))).toEqual(new Set(["runtime"]));
    expect(dockerfile).toMatch(/^FROM \S+ AS runtime\n(?:(?!FROM).*\n)*?USER node$/m);
  });

  it("starts every app with node as PID 1: an exec-form CMD, no shell or wrapper in front", () => {
    expect(appStages.filter(([, stage]) => stage.command[0] !== "node")).toEqual([]);
    expect(dockerfile).not.toMatch(/^(ENTRYPOINT|SHELL)\b|^CMD (?!\[)/m);
  });

  it.each([
    ["express", "examples/frameworks/express", "start"],
    ["nestjs", "examples/frameworks/nestjs", "start"],
    ["formats-cjs", "examples/formats", "start:cjs"],
    ["formats-esm", "examples/formats", "start:esm"],
    ["formats-tsc-cjs", "examples/formats", "start:tsc-cjs"],
    ["formats-tsc-esm", "examples/formats", "start:tsc-esm"],
    ["formats-bundled", "examples/formats", "start:bundled"],
  ])("starts %s with the file the %s script of %s runs", (stage, directory, script) => {
    const entry = readScripts(directory)[script]?.split(" ").at(-1);

    expect(stages.get(stage)?.command.at(-1)).toBe(entry);
  });

  it("puts every app at its path in the repository, so each breakpoint of the hub names a file in an image", () => {
    const destinations = [...dockerfile.matchAll(/^COPY --from=build \S+ \S+ \/app\/(\S+)$/gm)].map(
      (match) => `${match[1] ?? ""}/`,
    );
    const breakpoints = JSON.parse(hubEnvironment.HUB_BREAKPOINTS ?? "[]") as Array<{ file: string }>;
    const files = breakpoints.map(({ file }) => file);

    expect(files.filter((file) => !destinations.some((destination) => file.startsWith(destination)))).toEqual([]);
  });
});

describe("HOST", () => {
  it("is the address the hub listens on: an address the machine does not own stops it", () => {
    // 192.0.2.1 is TEST-NET-1: never assigned to a machine, so no one can bind to it, with or without DNS
    const env = createEnvironment();
    env.HOST = "192.0.2.1";
    const { status, stderr } = spawnSync(
      process.execPath,
      ["--conditions=@micafox/source", "--import", "tsx", path.join(KIT_DIR, "src", "fake-hub", "main.ts")],
      // A hub that ignored HOST would listen and never exit
      { cwd: KIT_DIR, env, encoding: "utf8", timeout: E2E_TEST_TIMEOUT_MS },
    );

    // The error code differs by OS (EADDRNOTAVAIL, EINVAL); what matters is that listen() took HOST
    expect({ status, failed: stderr.includes("fake hub failed: listen") && stderr.includes("192.0.2.1") }).toEqual({
      status: 1,
      failed: true,
    });
  });
});
