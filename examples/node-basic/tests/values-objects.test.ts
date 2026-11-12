import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, useProcesses } from "./harness.js";
import { captureValues, readVariable } from "./values-capture.js";

const numbers = (values: number[]): unknown[] => values.map((value) => ({ type: "number", value }));

describe("snapshot of class instances and built-in objects", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("encodes a class instance, Date, RegExp, Error, Buffer, typed array, function and Promise", async () => {
    const { snapshot, httpStatus } = await captureValues("objects");

    expect({
      httpStatus,
      order: readVariable(snapshot, "order"),
      createdAt: readVariable(snapshot, "createdAt"),
      pattern: readVariable(snapshot, "pattern"),
      failure: readVariable(snapshot, "failure"),
      buffer: readVariable(snapshot, "buffer"),
      bytes: readVariable(snapshot, "bytes"),
      total: readVariable(snapshot, "total"),
      pending: readVariable(snapshot, "pending"),
    }).toEqual({
      httpStatus: 200,
      order: {
        type: "object",
        className: "Order",
        properties: [
          { name: "id", value: { type: "string", value: "o-17", length: 4 } },
          { name: "quantity", value: { type: "number", value: 3 } },
          { name: "note", value: { type: "string", value: "gift", length: 4 } },
        ],
      },
      // To the whole second: the milliseconds of the date are .678
      createdAt: { type: "date", value: "2026-11-12T10:30:45.000Z" },
      // Neither has own enumerable properties; the pattern and the state are not captured
      pattern: { type: "object", className: "RegExp", properties: [] },
      failure: {
        type: "error",
        className: "RangeError",
        message: "out of stock",
        stack: expect.stringMatching(/^RangeError: out of stock\n {4}at .*values\.ts/) as unknown,
      },
      buffer: { type: "array", length: 5, items: numbers([104, 101, 108, 108, 111]) },
      bytes: { type: "array", length: 3, items: numbers([1, 2, 3]) },
      total: { type: "function", name: "total" },
      pending: { type: "object", className: "Promise", properties: [] },
    });
  });
});
