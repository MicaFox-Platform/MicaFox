import type { WorkBudget } from "./sliced-work.js";

// The keys being sorted, with the segment each came from; a pass reads one pair of arrays and writes the other
interface Run {
  readonly keys: Float64Array;
  readonly segmentIndexes: Int32Array;
}

interface Pass {
  readonly from: Run;
  readonly to: Run;
}

// Two sorted runs of `from`: [start, middle) and [middle, end)
interface Bounds {
  readonly start: number;
  readonly middle: number;
  readonly end: number;
}

// Runs this short are sorted by insertion first, which saves the five shortest merge passes
const INSERTION_RUN = 32;

// Reads an index the caller keeps in range; the fallback only satisfies `noUncheckedIndexedAccess`
const keyAt = (keys: Float64Array, index: number): number => keys[index] ?? 0;
const indexAt = (indexes: Int32Array, index: number): number => indexes[index] ?? 0;

// A stable insertion sort of [start, end): a key moves left only past larger keys
const sortRun = ({ keys, segmentIndexes }: Run, start: number, end: number): number => {
  let steps = 0;
  for (let next = start + 1; next < end; next += 1) {
    const key = keyAt(keys, next);
    const segmentIndex = indexAt(segmentIndexes, next);
    let slot = next;
    for (; slot > start && keyAt(keys, slot - 1) > key; slot -= 1) {
      keys[slot] = keyAt(keys, slot - 1);
      segmentIndexes[slot] = indexAt(segmentIndexes, slot - 1);
    }

    keys[slot] = key;
    segmentIndexes[slot] = segmentIndex;
    steps += next - slot + 1;
  }

  return steps;
};

const mergeRuns = function* ({ from, to }: Pass, { start, middle, end }: Bounds, budget: WorkBudget) {
  let left = start;
  let right = middle;
  let output = start;

  while (left < middle && right < end) {
    // A tie takes the left run, which keeps the sort stable
    const isRightFirst = keyAt(from.keys, right) < keyAt(from.keys, left);
    const taken = isRightFirst ? right : left;
    to.keys[output] = keyAt(from.keys, taken);
    to.segmentIndexes[output] = indexAt(from.segmentIndexes, taken);
    output += 1;
    right += Number(isRightFirst);
    left += Number(!isRightFirst);
    if (budget.spend(1)) {
      yield;
    }
  }

  to.keys.set(from.keys.subarray(left, middle), output);
  to.segmentIndexes.set(from.segmentIndexes.subarray(left, middle), output);
  const rightOutput = output + (middle - left);
  to.keys.set(from.keys.subarray(right, end), rightOutput);
  to.segmentIndexes.set(from.segmentIndexes.subarray(right, end), rightOutput);
  if (budget.spend(end - start)) {
    yield;
  }
};

const createRuns = function* (keys: Float64Array, budget: WorkBudget): Generator<void, Run, void> {
  const run: Run = { keys: keys.slice(), segmentIndexes: new Int32Array(keys.length) };
  for (let start = 0; start < keys.length; start += INSERTION_RUN) {
    const end = Math.min(start + INSERTION_RUN, keys.length);
    for (let index = start; index < end; index += 1) {
      run.segmentIndexes[index] = index;
    }

    if (budget.spend(sortRun(run, start, end))) {
      yield;
    }
  }

  return run;
};

/**
 * Returns the indexes of the segments ordered by original key. Equal keys keep their generated order, so the first
 * of them has the smallest generated position. Insertion-sorted runs, then a bottom-up merge sort over sequential
 * memory, O(n log n), written as a job because `Array.prototype.sort` cannot pause. Needs room for three copies of
 * the keys while it runs and keeps none.
 */
export const sortByOriginal = function* (keys: Float64Array, budget: WorkBudget): Generator<void, Int32Array, void> {
  let from = yield* createRuns(keys, budget);
  let to: Run = { keys: new Float64Array(keys.length), segmentIndexes: new Int32Array(keys.length) };

  for (let width = INSERTION_RUN; width < keys.length; width *= 2) {
    for (let start = 0; start < keys.length; start += 2 * width) {
      const middle = Math.min(start + width, keys.length);
      const end = Math.min(start + 2 * width, keys.length);
      yield* mergeRuns({ from, to }, { start, middle, end }, budget);
    }

    [from, to] = [to, from];
  }

  return from.segmentIndexes;
};
