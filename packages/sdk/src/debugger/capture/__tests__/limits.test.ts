import { describe, expect, it } from "vitest";

import { largestLimits, resolveLimits, truncateText } from "../limits.js";

describe("resolveLimits", () => {
  it("defaults to a depth of 3, 20 items and 256 code units", () => {
    expect(resolveLimits(undefined)).toEqual({ maxDepth: 3, maxItems: 20, maxStringLength: 256 });
  });

  it("keeps the limits that are set and defaults the others", () => {
    expect(resolveLimits({ maxItems: 7 })).toEqual({ maxDepth: 3, maxItems: 7, maxStringLength: 256 });
  });

  it("lowers larger values to 5, 100 and 4096", () => {
    expect(resolveLimits({ maxDepth: 6, maxItems: 101, maxStringLength: 5000 })).toEqual({
      maxDepth: 5,
      maxItems: 100,
      maxStringLength: 4096,
    });
  });
});

describe("largestLimits", () => {
  it("takes the largest of each limit across the breakpoints", () => {
    expect(largestLimits([{ maxDepth: 5, maxItems: 5 }, { maxItems: 50 }, undefined])).toEqual({
      maxDepth: 5,
      maxItems: 50,
      maxStringLength: 256,
    });
  });

  it("is the defaults for no breakpoint", () => {
    expect(largestLimits([])).toEqual({ maxDepth: 3, maxItems: 20, maxStringLength: 256 });
  });

  it("applies the caps before comparing", () => {
    expect(largestLimits([{ maxItems: 1000 }, { maxItems: 10 }]).maxItems).toBe(100);
  });
});

describe("truncateText", () => {
  it("keeps a text that fits", () => {
    expect(truncateText("abc", 3)).toBe("abc");
  });

  it("cuts after maxLength UTF-16 code units", () => {
    expect(truncateText("abcdef", 4)).toBe("abcd");
  });

  it("drops a high surrogate whose pair would be cut", () => {
    expect(truncateText("a\u{1F600}b", 2)).toBe("a");
  });

  it("keeps a whole pair that ends at maxLength", () => {
    expect(truncateText("a\u{1F600}b", 3)).toBe("a\u{1F600}");
  });

  it("keeps a lone high surrogate that no low surrogate follows", () => {
    expect(truncateText("a\uD83Db", 2)).toBe("a\uD83D");
  });
});
