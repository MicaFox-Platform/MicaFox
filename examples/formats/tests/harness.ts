// Starts one app of this example and the kit's fake hub as real child processes. The apps run under plain `node`, so
// they load the SDK's built `dist/`. Processes, waits and the fake hub come from @micafox/testkit.

import type { BreakpointStatus } from "@micafox/protocol";
import {
  createEnvironment,
  findMarkerLine,
  LISTENING,
  startHub as startFakeHub,
  startProcess,
  waitForStatus as waitForBreakpointStatus,
  type ChildProcessRun,
  type ListeningRun,
} from "@micafox/testkit";
import path from "node:path";

const EXAMPLE_DIR = path.join(import.meta.dirname, "..");
const QUOTE_MARKER = "// breakpoint here";

// The id of the one breakpoint each test sets
const BREAKPOINT_ID = "bp-quote";

/** One app of src/: the file node runs and the source file of `quote()`, both relative to the example. */
export interface App {
  readonly name: string;
  readonly entry: string;
  readonly quoteSource: string;
}

/** The apps whose format the SDK supports: plain JavaScript as is, TypeScript as tsc compiled it. */
export const SUPPORTED_APPS: readonly App[] = [
  { name: "cjs", entry: "src/cjs/server.js", quoteSource: "src/cjs/quote.js" },
  { name: "esm", entry: "src/esm/server.js", quoteSource: "src/esm/quote.js" },
  { name: "tsc-cjs", entry: "dist/tsc-cjs/server.js", quoteSource: "src/tsc-cjs/quote.ts" },
  { name: "tsc-esm", entry: "dist/tsc-esm/server.js", quoteSource: "src/tsc-esm/quote.ts" },
];

/** The app esbuild bundled with the SDK into one file: a format the SDK does not support. */
export const BUNDLED_APP: App = {
  name: "bundled",
  entry: "dist/bundled/server.cjs",
  quoteSource: "src/bundled/quote.ts",
};

/** The path of `file` in the repository, as a hub sets a breakpoint on it. */
export const toRepositoryPath = (file: string): string => `examples/formats/${file}`;

/** The 1-based line of the return of `quote()` in `app`, found by its marker so edits do not break tests. */
export const findQuoteLine = (app: App): number =>
  findMarkerLine(path.join(EXAMPLE_DIR, app.quoteSource), QUOTE_MARKER);

/** Starts the fake hub with one breakpoint on the return of `quote()` in `app`; resolves once it listens. */
export const startHub = (app: App): Promise<ListeningRun> => {
  const breakpoint = { id: BREAKPOINT_ID, file: toRepositoryPath(app.quoteSource), line: findQuoteLine(app) };
  return startFakeHub({ breakpoints: [breakpoint] });
};

/** Starts `app` connected to the fake hub on `hubPort`; resolves once it serves HTTP. */
export const startApp = (app: App, hubPort: number): Promise<ListeningRun> => {
  const env = createEnvironment();
  env.MICAFOX_HUB_URL = `ws://127.0.0.1:${String(hubPort)}/micafox`;
  const args = [path.join(EXAMPLE_DIR, app.entry)];
  return startProcess({ name: `${app.name} app`, args, env, cwd: EXAMPLE_DIR, readiness: LISTENING });
};

/** The URL of `GET /quote` on the app on `port`. */
export const toQuoteUrl = (port: number): string => `http://127.0.0.1:${String(port)}/quote?sku=SKU-2&quantity=3`;

/** Resolves with the first `breakpointStatus` of BREAKPOINT_ID the fake hub printed that `isWanted` accepts. */
export const waitForStatus = (
  hub: ChildProcessRun,
  isWanted?: (status: BreakpointStatus) => boolean,
): Promise<BreakpointStatus> => waitForBreakpointStatus(hub, BREAKPOINT_ID, isWanted);
