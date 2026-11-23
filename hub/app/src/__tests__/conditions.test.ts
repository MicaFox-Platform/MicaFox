import { describe, expect, it } from "vitest";

import { BuildFlagError, buildDefines, buildOf, conditionsOf, nodeConditionFlags } from "../conditions.js";

// The environment as the shell gives it, with EE set to `value` or unset
const envWithEe = (value: string | undefined): Record<string, string | undefined> =>
  Object.fromEntries([["EE", value]]);

describe("buildOf", () => {
  it.each([
    [undefined, "hub"],
    ["true", "hub"],
    ["false", "basic-hub"],
  ])("builds %s as the %s", (value, build) => {
    expect(buildOf(envWithEe(value))).toBe(build);
  });

  it.each(["0", "False", "no", ""])("refuses EE=%j rather than build the hub with ee/", (value) => {
    expect(() => buildOf(envWithEe(value))).toThrow(BuildFlagError);
  });
});

describe("conditionsOf", () => {
  it("adds micafox-open-core for the basic hub, so #ee resolves to the stubs", () => {
    expect(conditionsOf("basic-hub")).toEqual(["micafox-open-core"]);
  });

  it("adds no condition for the hub, so #ee resolves to the extension", () => {
    expect(conditionsOf("hub")).toEqual([]);
  });
});

describe("nodeConditionFlags", () => {
  it("gives node the basic hub's condition as a --conditions flag", () => {
    expect(nodeConditionFlags("basic-hub")).toEqual(["--conditions=micafox-open-core"]);
  });
});

describe("buildDefines", () => {
  it("replaces the build and version globals with string literals", () => {
    expect(Object.entries(buildDefines("basic-hub", "1.4.0"))).toEqual([
      ["MICAFOX_HUB_BUILD", '"basic-hub"'],
      ["MICAFOX_HUB_VERSION", '"1.4.0"'],
    ]);
  });
});
