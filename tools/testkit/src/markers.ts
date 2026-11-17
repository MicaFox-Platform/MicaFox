// Finds the line a test sets its breakpoint on by a marker comment, so edits to the file do not break tests.

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The 1-based line of `file` that holds `marker`. A lost marker fails here, not as a breakpoint on line 0 that a test
 * would wait on until its timeout.
 */
export const findMarkerLine = (file: string, marker: string): number => {
  const index = readFileSync(file, "utf8")
    .split("\n")
    .findIndex((line) => line.includes(marker));
  if (index === -1) {
    throw new Error(`no line of ${path.basename(file)} holds the marker "${marker}"`);
  }

  return index + 1;
};
