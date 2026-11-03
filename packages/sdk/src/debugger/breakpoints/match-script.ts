import type { ScriptRecord } from "./script-registry.js";

/** The outcome of matching a repository path against the loaded scripts. */
export type ScriptMatch = { kind: "none" } | { kind: "one"; script: ScriptRecord } | { kind: "several" };

// How many segments, counted from the end, the two paths share
const countSharedTail = (first: readonly string[], second: readonly string[]): number => {
  let count = 0;
  while (
    count < first.length &&
    count < second.length &&
    first[first.length - 1 - count] === second[second.length - 1 - count]
  ) {
    count += 1;
  }

  return count;
};

/**
 * Picks the candidate whose path ends with the most segments of `fileSegments`; candidates already end in its last
 * segment. Two with the most give `several`. O(candidates × segments).
 */
export const matchScript = (fileSegments: readonly string[], candidates: readonly ScriptRecord[]): ScriptMatch => {
  let best: ScriptRecord | undefined;
  let bestCount = 0;
  let isTied = false;

  for (const script of candidates) {
    const count = countSharedTail(fileSegments, script.segments);
    if (count > bestCount) {
      best = script;
      bestCount = count;
      isTied = false;
    } else if (count === bestCount && best !== undefined) {
      isTied = true;
    }
  }

  if (best === undefined) {
    return { kind: "none" };
  }

  return isTied ? { kind: "several" } : { kind: "one", script: best };
};
