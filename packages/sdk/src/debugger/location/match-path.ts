/** A script or a source of a script's map that an entry may resolve to, with its path split into segments. */
export interface PathCandidate {
  readonly segments: readonly string[];
}

/**
 * The outcome of matching a repository path against the candidates: `found` holds every candidate with the winning
 * path, such as a file two chunks of a bundle hold, and `count` how many segments of the entry's file it ends with.
 */
export type PathMatch<Candidate extends PathCandidate> =
  { kind: "none" } | { kind: "found"; candidates: Candidate[]; count: number } | { kind: "several" };

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

const toPath = (segments: readonly string[]): string => segments.join("/");

/**
 * Picks the candidates whose path ends with the most segments of `fileSegments`; candidates already end in its last
 * segment. Candidates with the same path all win; two different paths with the most give `several`.
 * O(candidates × segments).
 */
export const matchPath = <Candidate extends PathCandidate>(
  fileSegments: readonly string[],
  candidates: readonly Candidate[],
): PathMatch<Candidate> => {
  let best: Candidate[] = [];
  let bestPath = "";
  let bestCount = 0;
  let isTied = false;

  for (const candidate of candidates) {
    const count = countSharedTail(fileSegments, candidate.segments);
    if (count > bestCount) {
      best = [candidate];
      bestPath = toPath(candidate.segments);
      bestCount = count;
      isTied = false;
    } else if (count === bestCount && best.length > 0) {
      isTied ||= toPath(candidate.segments) !== bestPath;
      best.push(candidate);
    }
  }

  if (best.length === 0) {
    return { kind: "none" };
  }

  return isTied ? { kind: "several" } : { kind: "found", candidates: best, count: bestCount };
};
