import { describe, expect, it } from "vitest";

import { drain } from "../../../../test/source-maps/drain.js";
import { decodeMappings, LINE_RADIX, NO_SOURCE, UNMAPPED } from "../decode-mappings.js";
import { WorkBudget } from "../sliced-work.js";

const ONE_SOURCE = new Int32Array([0]);

describe("decodeMappings", () => {
  it("keeps every segment in generated order with its original key", () => {
    const { value } = drain(decodeMappings("AACA,ECAA;AADA", new Int32Array([0, 1]), new WorkBudget(1000)));

    expect([[...value.generatedLines], [...value.generatedColumns], [...value.originalKeys]]).toEqual([
      [0, 0, 1],
      [0, 2, 0],
      [1, LINE_RADIX + 1, LINE_RADIX],
    ]);
  });

  it("gives a segment of a null source no original position", () => {
    const { value } = drain(decodeMappings("AAAA", new Int32Array([NO_SOURCE]), new WorkBudget(1000)));

    expect([...value.originalKeys]).toEqual([UNMAPPED]);
  });

  it("yields once per slice while it decodes segments", () => {
    const mappings = "AAAA,".repeat(200_000);

    const { yields } = drain(decodeMappings(mappings, ONE_SOURCE, new WorkBudget(1000)));

    // Counting the segments yields about 125 times; decoding them about 1000
    expect(yields).toBeGreaterThanOrEqual(1000);
  });

  it("yields once per slice while it reads a run of empty lines", () => {
    const mappings = ";".repeat(1_000_000);

    const { yields } = drain(decodeMappings(mappings, ONE_SOURCE, new WorkBudget(1000)));

    expect(yields).toBeGreaterThanOrEqual(1000);
  });

  it("yields while it counts the segments of a map that it then rejects", () => {
    const mappings = "A,".repeat(1_500_001);

    const job = decodeMappings(mappings, ONE_SOURCE, new WorkBudget(1000));

    // Each `next()` runs one slice: the count of 3 million characters takes several before the error
    expect([job.next().done, job.next().done, job.next().done]).toEqual([false, false, false]);
  });
});
