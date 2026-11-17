import { describe, expect, it } from "vitest";

import { matchPath } from "../match-path.js";
import { toSegments, type ScriptRecord } from "../script-registry.js";

const script = (path: string): ScriptRecord => ({
  url: `file://${path}`,
  segments: toSegments(path),
});

describe("matchPath", () => {
  it("gives none without candidates", () => {
    expect(matchPath(toSegments("src/orders/checkout.js"), [])).toEqual({ kind: "none" });
  });

  it("gives the only candidate", () => {
    const only = script("/app/dist/checkout.js");

    expect(matchPath(toSegments("src/orders/checkout.js"), [only])).toEqual({
      kind: "found",
      candidates: [only],
      count: 1,
    });
  });

  it("prefers the candidate that shares the most trailing segments", () => {
    const orders = script("/app/src/orders/checkout.js");
    const billing = script("/app/src/billing/checkout.js");

    expect(matchPath(toSegments("orders/checkout.js"), [billing, orders])).toEqual({
      kind: "found",
      candidates: [orders],
      count: 2,
    });
  });

  it("gives several when two candidates share the most segments", () => {
    const first = script("/a/src/checkout.js");
    const second = script("/b/src/checkout.js");

    expect(matchPath(toSegments("src/checkout.js"), [first, second])).toEqual({ kind: "several" });
  });

  it("gives several when only the file name is shared by both", () => {
    const orders = script("/app/orders/checkout.js");
    const billing = script("/app/billing/checkout.js");

    expect(matchPath(toSegments("checkout.js"), [orders, billing])).toEqual({ kind: "several" });
  });

  it("does not count a longer match as a tie with a shorter one", () => {
    const deep = script("/a/src/orders/checkout.js");
    const shallow = script("/b/orders/checkout.js");
    const other = script("/c/checkout.js");

    expect(matchPath(toSegments("src/orders/checkout.js"), [other, shallow, deep])).toEqual({
      kind: "found",
      candidates: [deep],
      count: 3,
    });
  });
});

describe("matchPath with one path in several scripts", () => {
  it("gives every candidate with the winning path, such as a file two chunks hold", () => {
    const first = { url: "file:///app/chunks/a.js", segments: toSegments("/app/src/checkout.ts") };
    const second = { url: "file:///app/chunks/b.js", segments: toSegments("/app/src/checkout.ts") };

    expect(matchPath(toSegments("src/checkout.ts"), [first, second])).toEqual({
      kind: "found",
      candidates: [first, second],
      count: 2,
    });
  });

  it("gives several when a third candidate with another path ties with them", () => {
    const first = script("/app/src/checkout.ts");
    const second = { url: "file:///app/chunks/b.js", segments: toSegments("/app/src/checkout.ts") };
    const other = script("/lib/src/checkout.ts");

    expect(matchPath(toSegments("src/checkout.ts"), [first, other, second])).toEqual({ kind: "several" });
  });
});

describe("toSegments", () => {
  it("splits on / and \\ and drops empty and . segments", () => {
    expect(toSegments("C:\\app\\src/./orders//checkout.js")).toEqual(["C:", "app", "src", "orders", "checkout.js"]);
  });
});
