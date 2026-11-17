// The example apps of compose.yaml as the container tests see them: the breakpoint the stack's hub sets on each, for
// its service only (toHubBreakpoints()), the port compose publishes and how the app ends on SIGTERM.

import path from "node:path";

import { findMarkerLine } from "../src/markers.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const QUOTE_MARKER = "// breakpoint here";

/** One service of compose.yaml that serves `GET /quote`. */
export interface DockerApp {
  readonly service: string;
  /** The host port compose publishes it on. */
  readonly port: number;
  /** The id of its breakpoint. */
  readonly breakpointId: string;
  /** The source of its quote handler, from the repository root, as the breakpoint names it. */
  readonly quoteSource: string;
  /** The exit code of its PID 1 after SIGTERM. */
  readonly exitOnSigterm: number;
  /** The path and query of its quote endpoint. */
  readonly quotePath: string;
}

const QUOTE_PATH = "/quote?sku=SKU-2&quantity=3";

const createFormatsApp = (name: string, port: number, quoteSource: string): DockerApp => ({
  service: `formats-${name}`,
  port,
  breakpointId: `bp-${name}`,
  quoteSource: `examples/formats/src/${quoteSource}`,
  exitOnSigterm: 0,
  quotePath: QUOTE_PATH,
});

/** Every app of compose.yaml. */
export const DOCKER_APPS: readonly DockerApp[] = [
  {
    service: "fastify",
    port: 3000,
    breakpointId: "bp-fastify",
    quoteSource: "examples/frameworks/fastify/src/pricing.ts",
    exitOnSigterm: 0,
    quotePath: "/price?sku=SKU-2&quantity=3",
  },
  {
    service: "express",
    port: 3001,
    breakpointId: "bp-express",
    quoteSource: "examples/frameworks/express/src/quote.js",
    exitOnSigterm: 0,
    quotePath: QUOTE_PATH,
  },
  {
    service: "nestjs",
    port: 3002,
    breakpointId: "bp-nestjs",
    quoteSource: "examples/frameworks/nestjs/src/quote.controller.ts",
    exitOnSigterm: 0,
    quotePath: QUOTE_PATH,
  },
  // `next build` bundles the route handler; `next start` exits with 128 + 15 after a clean shutdown
  {
    service: "nextjs",
    port: 3003,
    breakpointId: "bp-nextjs",
    quoteSource: "examples/frameworks/nextjs/src/app/quote/route.ts",
    exitOnSigterm: 143,
    quotePath: QUOTE_PATH,
  },
  createFormatsApp("cjs", 3101, "cjs/quote.js"),
  createFormatsApp("esm", 3102, "esm/quote.js"),
  createFormatsApp("tsc-cjs", 3103, "tsc-cjs/quote.ts"),
  createFormatsApp("tsc-esm", 3104, "tsc-esm/quote.ts"),
  // The debugger finds `quote.ts` by searching the map of `server.cjs`, whose name differs
  createFormatsApp("bundled", 3105, "bundled/quote.ts"),
];

/** The 1-based line of the marked line of `app`'s quote handler. */
export const findQuoteLine = (app: DockerApp): number => findMarkerLine(path.join(ROOT, app.quoteSource), QUOTE_MARKER);

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Matches the absolute path of `app`'s quote handler that a snapshot's top frame reports. */
export const toQuoteFilePattern = (app: DockerApp): RegExp => new RegExp(`/${escapeRegExp(app.quoteSource)}$`);

/** The URL of `app`'s quote endpoint on its published port. */
export const toQuoteUrl = (app: DockerApp): string => `http://127.0.0.1:${String(app.port)}${app.quotePath}`;

/** HUB_BREAKPOINTS of the stack: each app's breakpoint on its marked line, for its service only. */
export const toHubBreakpoints = (): string =>
  JSON.stringify(
    DOCKER_APPS.map((app) => ({
      id: app.breakpointId,
      file: app.quoteSource,
      line: findQuoteLine(app),
      service: app.service,
    })),
  );
