import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, useProcesses } from "./harness.js";
import { captureValues, readVariable } from "./values-capture.js";

describe("snapshot of primitives", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("encodes each primitive by its type, and NaN and -0, which JSON cannot carry, as words", async () => {
    const { snapshot, httpStatus } = await captureValues("primitives");

    expect({
      httpStatus,
      text: readVariable(snapshot, "text"),
      count: readVariable(snapshot, "count"),
      bigNumber: readVariable(snapshot, "bigNumber"),
      isReady: readVariable(snapshot, "isReady"),
      nothing: readVariable(snapshot, "nothing"),
      missing: readVariable(snapshot, "missing"),
      tag: readVariable(snapshot, "tag"),
      notANumber: readVariable(snapshot, "notANumber"),
      negativeZero: readVariable(snapshot, "negativeZero"),
    }).toEqual({
      httpStatus: 200,
      text: { type: "string", value: "hello", length: 5 },
      count: { type: "number", value: 42 },
      bigNumber: { type: "bigint", value: "12345678901234567890" },
      isReady: { type: "boolean", value: true },
      nothing: { type: "null" },
      missing: { type: "undefined" },
      tag: { type: "symbol", value: "Symbol(tag)" },
      notANumber: { type: "number", value: "NaN" },
      negativeZero: { type: "number", value: "-0" },
    });
  });
});
