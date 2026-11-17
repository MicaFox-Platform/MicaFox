import { E2E_TEST_TIMEOUT_MS, useProcesses } from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { captureValues, readVariable } from "./values-capture.js";

// An object value with the given properties, as the SDK encodes a plain object; without them, one not read
const plain = (properties?: Array<{ name: string; value: unknown }>): unknown =>
  properties === undefined
    ? { type: "object", className: "Object" }
    : { type: "object", className: "Object", properties };

const LOOP_NAME = { type: "string", value: "loop", length: 4 };

describe("snapshot of nested objects", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("keeps three levels by default, and reads an object that refers to itself again down to that depth", async () => {
    const { snapshot, httpStatus } = await captureValues("nesting");

    expect({
      httpStatus,
      deep: readVariable(snapshot, "deep"),
      loop: readVariable(snapshot, "loop"),
      truncated: snapshot.truncated,
    }).toEqual({
      httpStatus: 200,
      deep: plain([
        { name: "level1", value: plain([{ name: "level2", value: plain([{ name: "level3", value: plain() }]) }]) },
      ]),
      loop: plain([
        { name: "name", value: LOOP_NAME },
        {
          name: "next",
          value: plain([
            { name: "name", value: LOOP_NAME },
            {
              name: "next",
              value: plain([
                { name: "name", value: LOOP_NAME },
                { name: "next", value: plain() },
              ]),
            },
          ]),
        },
      ]),
      truncated: undefined,
    });
  });

  it("keeps five levels when the breakpoint raises maxDepth to five", async () => {
    const { snapshot, httpStatus } = await captureValues("nesting", { limits: { maxDepth: 5 } });

    const level5 = plain([{ name: "level5", value: { type: "string", value: "bottom", length: 6 } }]);
    const level3 = plain([{ name: "level3", value: plain([{ name: "level4", value: level5 }]) }]);
    expect({ httpStatus, deep: readVariable(snapshot, "deep") }).toEqual({
      httpStatus: 200,
      deep: plain([{ name: "level1", value: plain([{ name: "level2", value: level3 }]) }]),
    });
  });
});
