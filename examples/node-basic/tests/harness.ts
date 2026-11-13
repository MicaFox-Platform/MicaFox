// Starts the app of this example under tsx and the kit's fake hub as real child processes, the way a developer runs
// them with `pnpm dev` and `pnpm dev:hub`. Processes, waits and the fake hub come from @micafox/testkit.

import {
  ChildProcessRun,
  createEnvironment,
  findMarkerLine,
  parseJsonLine,
  startHub as startFakeHub,
  startProcess,
  type HubOptions,
  type ListeningRun,
} from "@micafox/testkit";
import path from "node:path";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");
const APP_FILE = path.join(EXAMPLE_DIR, "src", "index.ts");
const PRICING_FILE = path.join(EXAMPLE_DIR, "src", "pricing.ts");
const PRICING_MARKER = "// breakpoint here";
// The sample breakpoints of `pnpm dev:hub`: one on the return of quote(), at PRICING_LINE
const SAMPLE_BREAKPOINTS_FILE = path.join(EXAMPLE_DIR, "src", "hub", "sample-breakpoints.json");
// The app's Fastify logs `Server listening at http://127.0.0.1:<port>` through pino
const APP_LISTENING = /"msg":"Server listening at http:\/\/127\.0\.0\.1:(\d+)"/;

/** The 1-based line of the return of `quote()` in `src/pricing.ts`, found by its marker so edits do not break tests. */
export const PRICING_LINE = findMarkerLine(PRICING_FILE, PRICING_MARKER);

/** Starts the fake hub as `pnpm dev:hub` does, with its sample breakpoint unless `breakpoints` is set. */
export const startHub = (options: HubOptions = {}): Promise<ListeningRun> =>
  startFakeHub({ breakpointsFile: SAMPLE_BREAKPOINTS_FILE, ...options });

/** How the app is started; each field is unset by default. */
export interface AppOptions {
  /** `PORT`; a free port by default. */
  port?: number;
  /** `MICAFOX_HUB_URL` for the fake hub on this port. */
  hubPort?: number;
  /** `MICAFOX_TOKEN`. */
  token?: string;
  /** `MICAFOX_SERVICE`. */
  service?: string;
  /** `MICAFOX_LABELS`, such as `team=payments,region=eu`. */
  labels?: string;
  /** `MICAFOX_ENABLED`. */
  enabled?: string;
  /** `MICAFOX_LOG_LEVEL`. */
  logLevel?: string;
  /** `PRICING_API_KEY`, the secret of `src/pricing.ts`. */
  pricingApiKey?: string;
  /** `VALUES_SECRET`, the secret the `/values/secrets` route nests in its values. */
  valuesSecret?: string;
}

const APP_VARIABLES: ReadonlyArray<[keyof AppOptions, string]> = [
  ["port", "PORT"],
  ["token", "MICAFOX_TOKEN"],
  ["service", "MICAFOX_SERVICE"],
  ["labels", "MICAFOX_LABELS"],
  ["enabled", "MICAFOX_ENABLED"],
  ["logLevel", "MICAFOX_LOG_LEVEL"],
  ["pricingApiKey", "PRICING_API_KEY"],
  ["valuesSecret", "VALUES_SECRET"],
];

/** Starts the app; resolves once it serves HTTP. */
export const startApp = (options: AppOptions = {}): Promise<ListeningRun> => {
  // The developer's own secrets of the app never reach it: each test sets its own
  const env = createEnvironment({ names: ["PRICING_API_KEY", "VALUES_SECRET"] });
  if (options.hubPort !== undefined) {
    env.MICAFOX_HUB_URL = `ws://127.0.0.1:${String(options.hubPort)}/micafox`;
  }
  for (const [option, variable] of APP_VARIABLES) {
    const value = options[option];
    if (value !== undefined) {
      env[variable] = String(value);
    }
  }
  // The source condition, as `pnpm dev` runs the app; tsx as an import, so no wrapper process can be orphaned
  const args = ["--conditions=@micafox/source", "--import", "tsx", APP_FILE];
  const readiness = { ready: APP_LISTENING, port: APP_LISTENING };
  return startProcess({ name: "app", args, env, cwd: EXAMPLE_DIR, readiness });
};

/** The URL of `route` on the app on `port`. */
export const toAppUrl = (port: number, route: string): string => `http://127.0.0.1:${String(port)}${route}`;

/** The `msg` of a line the app's pino printed; `undefined` for any other line. */
export const readLogMessage = (line: string): string | undefined => {
  const message = parseJsonLine(line);
  const text: unknown = message === undefined ? undefined : Reflect.get(message, "msg");
  return typeof text === "string" ? text : undefined;
};

/** Resolves with the first line the app's pino printed whose message contains `text`. */
export const waitForLog = async (run: ChildProcessRun, text: string): Promise<string> => {
  const [line = ""] = await run.waitForLines((candidate) => readLogMessage(candidate)?.includes(text) === true);
  return line;
};
