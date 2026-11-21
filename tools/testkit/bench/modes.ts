// The four modes the benchmark compares, each as the app's environment and the fake hub's breakpoints. The lines come
// from their marker comments, so an edit to the example cannot silently turn the hot line cold.

import path from "node:path";

import { findMarkerLine } from "../src/markers.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const APP_SOURCES = "sandbox/frameworks/fastify/src";
// /price runs quote() on every request; it never runs the routes of values.ts
const HOT_FILE = `${APP_SOURCES}/pricing.ts`;
const COLD_FILE = `${APP_SOURCES}/values.ts`;

/** One mode: its table row, the app's environment and the breakpoint the hub sets, if any. */
export interface Mode {
  readonly label: string;
  readonly isEnabled: boolean;
  /** Whether the hub must receive snapshots: only from the hot line, and none from the cold one. */
  readonly expectsSnapshots: boolean;
  readonly breakpoint?: { readonly id: string; readonly file: string; readonly line: number };
}

/** The modes in table order: SDK off, SDK on without breakpoints, a cold breakpoint, a hot one. */
export const createModes = (): Mode[] => [
  { label: "SDK off (`MICAFOX_ENABLED=false`)", isEnabled: false, expectsSnapshots: false },
  { label: "SDK on, no breakpoints", isEnabled: true, expectsSnapshots: false },
  {
    label: "1 breakpoint, cold line",
    isEnabled: true,
    expectsSnapshots: false,
    breakpoint: {
      id: "bp-cold",
      file: COLD_FILE,
      line: findMarkerLine(path.join(ROOT, COLD_FILE), "// breakpoint on the next line: primitives") + 1,
    },
  },
  {
    label: "1 breakpoint, hot line (rate-limited)",
    isEnabled: true,
    expectsSnapshots: true,
    breakpoint: { id: "bp-hot", file: HOT_FILE, line: findMarkerLine(path.join(ROOT, HOT_FILE), "// breakpoint here") },
  },
];
