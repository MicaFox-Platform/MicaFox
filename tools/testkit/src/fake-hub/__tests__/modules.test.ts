import { describe, expect, it } from "vitest";

import { acceptModules } from "../modules.js";

describe("acceptModules", () => {
  it("accepts the debugger a hello lists", () => {
    expect(acceptModules(["debugger"])).toEqual(["debugger"]);
  });

  it("leaves out the modules the hub does not know", () => {
    expect(acceptModules(["errors", "debugger", "logpoints"])).toEqual(["debugger"]);
  });

  it("lists a module once when the hello repeats it", () => {
    expect(acceptModules(["debugger", "debugger"])).toEqual(["debugger"]);
  });

  it("accepts nothing when the hello lists no module the hub knows", () => {
    expect(acceptModules(["errors"])).toEqual([]);
  });

  it("ignores entries that are not strings", () => {
    expect(acceptModules([1, null, { name: "debugger" }, "debugger"])).toEqual(["debugger"]);
  });

  it.each([
    ["missing", undefined],
    ["a string", "debugger"],
    ["an object", { debugger: true }],
    ["null", null],
  ])("accepts nothing when the hello's modules are %s", (_name, modules) => {
    expect(acceptModules(modules)).toEqual([]);
  });
});
