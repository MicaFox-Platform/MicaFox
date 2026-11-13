import { E2E_TEST_TIMEOUT_MS, useProcesses } from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { captureValues, readVariable } from "./values-capture.js";

describe("snapshot of arrays, sets and maps", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("keeps the children of a collection with at most maxItems, and only the size of a larger one", async () => {
    const { snapshot, httpStatus } = await captureValues("collections");

    expect({
      httpStatus,
      smallList: readVariable(snapshot, "smallList"),
      smallSet: readVariable(snapshot, "smallSet"),
      smallMap: readVariable(snapshot, "smallMap"),
      bigList: readVariable(snapshot, "bigList"),
      bigSet: readVariable(snapshot, "bigSet"),
      bigMap: readVariable(snapshot, "bigMap"),
    }).toEqual({
      httpStatus: 200,
      smallList: {
        type: "array",
        length: 3,
        items: [
          { type: "number", value: 1 },
          { type: "number", value: 2 },
          { type: "number", value: 3 },
        ],
      },
      smallSet: {
        type: "set",
        size: 2,
        items: [
          { type: "string", value: "a", length: 1 },
          { type: "string", value: "b", length: 1 },
        ],
      },
      smallMap: {
        type: "map",
        size: 1,
        entries: [{ key: { type: "string", value: "one", length: 3 }, value: { type: "number", value: 1 } }],
      },
      bigList: { type: "array", length: 25 },
      bigSet: { type: "set", size: 25 },
      bigMap: { type: "map", size: 25 },
    });
  });

  it("keeps only the size of a collection above the breakpoint's own maxItems of 2", async () => {
    const { snapshot, httpStatus } = await captureValues("collections", { limits: { maxItems: 2 } });

    expect({
      httpStatus,
      smallList: readVariable(snapshot, "smallList"),
      smallSet: readVariable(snapshot, "smallSet"),
    }).toEqual({
      httpStatus: 200,
      smallList: { type: "array", length: 3 },
      smallSet: {
        type: "set",
        size: 2,
        items: [
          { type: "string", value: "a", length: 1 },
          { type: "string", value: "b", length: 1 },
        ],
      },
    });
  });
});
