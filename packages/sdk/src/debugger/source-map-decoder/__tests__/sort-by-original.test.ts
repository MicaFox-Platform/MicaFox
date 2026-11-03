import { describe, expect, it } from "vitest";

import { drain } from "../../../../test/source-maps/drain.js";
import { WorkBudget } from "../sliced-work.js";
import { sortByOriginal } from "../sort-by-original.js";

const sortKeys = (keys: readonly number[], unitsPerSlice = 1000) =>
  drain(sortByOriginal(new Float64Array(keys), new WorkBudget(unitsPerSlice)));

// A fixed seed makes a failure reproducible
const createRandomKeys = (count: number, limit: number): number[] => {
  let seed = 99;
  return Array.from({ length: count }, () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  });
};

const isOrderedByKeyThenIndex = (keys: readonly number[], order: Int32Array): boolean =>
  [...order].every((segment, place) => {
    const previous = order[place - 1];
    const key = keys[segment] ?? 0;
    const previousKey = previous === undefined ? -Infinity : (keys[previous] ?? 0);
    return previous === undefined || previousKey < key || (previousKey === key && previous < segment);
  });

describe("sortByOriginal", () => {
  it("orders a short list by key", () => {
    const { value } = sortKeys([5, -1, 3, 0]);

    expect([...value]).toEqual([1, 3, 2, 0]);
  });

  it("keeps equal keys in generated order", () => {
    const { value } = sortKeys([2, 1, 2, 1, 2]);

    expect([...value]).toEqual([1, 3, 0, 2, 4]);
  });

  it.each([0, 1, 31, 32, 33, 64, 1000, 4097])("orders %d random keys by key, then by generated order", (count) => {
    const keys = createRandomKeys(count, 50);

    const { value } = sortKeys(keys);

    expect([value.length, isOrderedByKeyThenIndex(keys, value)]).toEqual([count, true]);
  });

  it("yields once per slice while it merges", () => {
    const keys = createRandomKeys(100_000, 1_000_000);

    const { yields } = sortKeys(keys);

    // 100,000 keys take about 100,000 × log2(100,000 / 32) comparisons, over 1,100,000
    expect(yields).toBeGreaterThanOrEqual(1100);
  });

  it("yields once per slice while it sorts the short runs", () => {
    // Each of the 32 runs costs 527 steps, more than a slice of 100: it yields after each, and about 43 times in merges
    const keys = Array.from({ length: 1024 }, (_, index) => 1024 - index);

    const { yields } = sortKeys(keys, 100);

    expect(yields).toBeGreaterThanOrEqual(70);
  });

  it("does not change the keys it sorts", () => {
    const keys = new Float64Array([3, 1, 2]);

    drain(sortByOriginal(keys, new WorkBudget(1000)));

    expect([...keys]).toEqual([3, 1, 2]);
  });
});
