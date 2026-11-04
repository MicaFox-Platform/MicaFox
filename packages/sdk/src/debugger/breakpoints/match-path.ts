/** A script or a source of a script's map that an entry may resolve to, with its path split into segments. */
export interface PathCandidate {
  readonly segments: readonly string[];
}

/** The outcome of matching a repository path against the candidates. */
export type PathMatch<Candidate extends PathCandidate> =
  { kind: "none" } | { kind: "one"; candidate: Candidate } | { kind: "several" };

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
export const matchPath = <Candidate extends PathCandidate>(
  fileSegments: readonly string[],
  candidates: readonly Candidate[],
): PathMatch<Candidate> => {
  let best: Candidate | undefined;
  let bestCount = 0;
  let isTied = false;

  for (const candidate of candidates) {
    const count = countSharedTail(fileSegments, candidate.segments);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
      isTied = false;
    } else if (count === bestCount && best !== undefined) {
      isTied = true;
    }
  }

  if (best === undefined) {
    return { kind: "none" };
  }

  return isTied ? { kind: "several" } : { kind: "one", candidate: best };
};
