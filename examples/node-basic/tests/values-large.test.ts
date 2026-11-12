import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, useProcesses } from "./harness.js";
import { captureValues, readVariable } from "./values-capture.js";

const KIB = 1024;
// The SDK checks its 64 KiB budget before each value, so the value that crosses it is still kept: here one string of
// 4096 ASCII characters with its field names. The margin covers that one value, not a growing overshoot
const MAX_TRUNCATED_BYTES = 64 * KIB + 8 * KIB;
const CAPS = { maxItems: 100, maxStringLength: 4096 };

interface ObjectValue {
  properties?: Array<{ value: unknown }>;
  truncated?: boolean;
}

describe("snapshot of values larger than 64 KiB", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("cuts a huge string to maxStringLength and an object to maxItems, not truncating the snapshot", async () => {
    const { snapshot, httpStatus } = await captureValues("large");

    // The route's hugeObject is an object; a missing one gives undefined fields, which fails the assertion
    const hugeObject = readVariable(snapshot, "hugeObject") as ObjectValue | undefined;
    expect({
      httpStatus,
      hugeText: readVariable(snapshot, "hugeText"),
      hugeObjectProperties: hugeObject?.properties?.length,
      isHugeObjectTruncated: hugeObject?.truncated,
      truncated: snapshot.truncated,
    }).toEqual({
      httpStatus: 200,
      hugeText: { type: "string", value: "x".repeat(256), length: 100_000 },
      hugeObjectProperties: 20,
      isHugeObjectTruncated: true,
      truncated: undefined,
    });
  });

  it("truncates the snapshot near 64 KiB of JSON and says why in the first value it did not read", async () => {
    const { snapshot, httpStatus } = await captureValues("large", { limits: CAPS });

    // As in the test above
    const hugeObject = readVariable(snapshot, "hugeObject") as ObjectValue | undefined;
    expect({
      httpStatus,
      truncated: snapshot.truncated,
      lastProperty: hugeObject?.properties?.at(-1)?.value,
      isWithinSize: Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_TRUNCATED_BYTES,
    }).toEqual({
      httpStatus: 200,
      truncated: true,
      lastProperty: { type: "unavailable", reason: "the snapshot reached its size limit" },
      isWithinSize: true,
    });
  });
});
