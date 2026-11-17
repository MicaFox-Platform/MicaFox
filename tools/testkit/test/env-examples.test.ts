// The `.env.example` files and `start` scripts that let a developer run every example by hand: the hub's breakpoints
// must sit on the lines the apps mark, the ports must not collide, and no script the tests use may read a `.env`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const BREAKPOINT_MARKER = "// breakpoint here";
// `PORT=${PORT:-3101} node ...`: the default port of a `start:<app>` script of examples/formats
const SCRIPT_PORT = /PORT=\$\{PORT:-(\d+)\}/;

const readText = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");
const readEnvFile = (file: string): Record<string, string | undefined> => parseEnv(readText(file));
const readScripts = (directory: string): Record<string, string> =>
  (JSON.parse(readText(`${directory}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {};

const FRAMEWORKS = readdirSync(path.join(ROOT, "examples", "frameworks")).map((name) => `examples/frameworks/${name}`);
const APP_PACKAGES = ["examples/formats", ...FRAMEWORKS].filter((directory) =>
  existsSync(path.join(ROOT, directory, "package.json")),
);
const HUB_PACKAGE = "tools/testkit";

interface Breakpoint {
  readonly id: string;
  readonly file: string;
  readonly line: number;
}

const hubEnvironment = readEnvFile(`${HUB_PACKAGE}/.env.example`);
const hubPort = Number(hubEnvironment.PORT);
const breakpoints = JSON.parse(hubEnvironment.HUB_BREAKPOINTS ?? "[]") as Breakpoint[];

/** The default ports of one app package: its `.env.example` PORT, or the defaults of its `start:<app>` scripts. */
const readAppPorts = (directory: string): number[] => {
  const port = readEnvFile(`${directory}/.env.example`).PORT;
  if (port !== undefined) {
    return [Number(port)];
  }

  return Object.values(readScripts(directory)).flatMap((script) => {
    const match = SCRIPT_PORT.exec(script);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
};

const appPorts = APP_PACKAGES.flatMap(readAppPorts);

// The source folder of each app: one per framework package, one per `start:<app>` script of examples/formats
const APP_SOURCES = APP_PACKAGES.flatMap((directory) => {
  const apps = Object.keys(readScripts(directory)).flatMap((name) => {
    const [script, app] = name.split(":");
    return script === "start" && app !== undefined ? [`${directory}/src/${app}/`] : [];
  });
  return apps.length === 0 ? [`${directory}/src/`] : apps;
});

describe("the hub's .env.example", () => {
  it("gives every breakpoint its own id", () => {
    const ids = breakpoints.map((breakpoint) => breakpoint.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(APP_SOURCES)("sets one breakpoint in %s", (source) => {
    expect(breakpoints.filter((breakpoint) => breakpoint.file.startsWith(source))).toHaveLength(1);
  });

  it.each(breakpoints)("sets $id on a line of $file that holds the breakpoint marker", ({ file, line }) => {
    const lines = readText(file).split("\n");

    expect(lines[line - 1]).toContain(BREAKPOINT_MARKER);
  });
});

describe("the ports of the examples", () => {
  it("are fixed, distinct from each other and from the hub's", () => {
    expect([...appPorts, hubPort].sort((a, b) => a - b)).toEqual([
      3000, 3001, 3002, 3003, 3101, 3102, 3103, 3104, 3105, 8787,
    ]);
  });

  it("are listed in examples/README.md", () => {
    const readme = readText("examples/README.md");

    // A row of the table of apps, not any mention of the number
    expect(appPorts.filter((port) => !readme.includes(`| \`${String(port)}\` |`))).toEqual([]);
  });

  it.each(APP_PACKAGES)("point the hub URL of %s at the hub's port", (directory) => {
    const { MICAFOX_HUB_URL: hubUrl } = readEnvFile(`${directory}/.env.example`);

    expect(hubUrl).toBe(`ws://127.0.0.1:${String(hubPort)}/micafox`);
  });
});

describe("the scripts", () => {
  it.each([...APP_PACKAGES, HUB_PACKAGE])(
    "of %s read .env only in start and dev scripts, never in tests",
    (directory) => {
      const readers = Object.entries(readScripts(directory))
        .filter(([, script]) => script.includes("--env-file"))
        .map(([name]) => name);

      expect(readers.filter((name) => !/^(start|dev)(:|$)/.test(name))).toEqual([]);
    },
  );

  it.each([...APP_PACKAGES, HUB_PACKAGE])("of %s include a start script that reads .env if it exists", (directory) => {
    const starts = Object.entries(readScripts(directory)).filter(([name]) => name.startsWith("start"));

    expect(
      starts.map(([, script]) => script).filter((script) => !script.includes("--env-file-if-exists=.env")),
    ).toEqual([]);
    expect(starts).not.toHaveLength(0);
  });
});

describe("the .gitignore", () => {
  // --no-index: without it, git reports a tracked file as not ignored whatever .gitignore says. Status 0 is ignored,
  // 1 is not; anything else is git failing, which must not pass as either
  const isIgnored = (file: string): boolean => {
    const { status } = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: ROOT });
    if (status !== 0 && status !== 1) {
      throw new Error(`git check-ignore failed with status ${String(status)} for ${file}`);
    }

    return status === 0;
  };

  it.each([".env", ".env.local", ".env.production"])("ignores %s of an example", (name) => {
    expect(isIgnored(`examples/frameworks/fastify/${name}`)).toBe(true);
  });

  it.each([...APP_PACKAGES, HUB_PACKAGE])("keeps the .env.example of %s", (directory) => {
    expect(isIgnored(`${directory}/.env.example`)).toBe(false);
  });
});
