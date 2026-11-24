import { describe, expect, it, vi } from "vitest";

import { createEntitlements, ENTITLEMENT_TTL_MS } from "../entitlements.js";
import type { EntitlementSource } from "../entitlements.js";

const ORG = "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01";
const OTHER_ORG = "4d1e9c07-21b4-4f0a-8c3e-0a9f7e5d6b02";

const granting =
  (...names: string[]): EntitlementSource =>
  async () =>
    await Promise.resolve(new Set(names));

describe("createEntitlements", () => {
  it("answers no to every name when there is no source, as in S2", async () => {
    const entitlements = createEntitlements({ sources: [], now: () => 0 });

    expect([await entitlements(ORG).has("fixture-plan"), await entitlements(ORG).list()]).toEqual([false, []]);
  });

  it("unions what the sources say and lists it sorted", async () => {
    const entitlements = createEntitlements({
      sources: [granting("logs", "alerts"), granting("alerts", "audit")],
      now: () => 0,
    });

    expect([await entitlements(ORG).has("audit"), await entitlements(ORG).list()]).toEqual([
      true,
      ["alerts", "audit", "logs"],
    ]);
  });

  it("asks the sources once per organization for 60 s, then again", async () => {
    let now = 1_000;
    const source = vi.fn(granting("logs"));
    const entitlements = createEntitlements({ sources: [source], now: () => now });

    await entitlements(ORG).has("logs");
    now += ENTITLEMENT_TTL_MS - 1;
    await entitlements(ORG).has("logs");
    await entitlements(OTHER_ORG).has("logs");
    now += 1;
    await entitlements(ORG).has("logs");

    expect(source.mock.calls.map(([orgId]) => orgId)).toEqual([ORG, OTHER_ORG, ORG]);
  });

  it("shares one question between requests that arrive together", async () => {
    const source = vi.fn(granting("logs"));
    const entitlements = createEntitlements({ sources: [source], now: () => 0 });

    await Promise.all([entitlements(ORG).has("logs"), entitlements(ORG).list()]);

    expect(source).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failure: the next question asks the source again", async () => {
    const source = vi
      .fn<EntitlementSource>()
      .mockRejectedValueOnce(new Error("source down"))
      .mockResolvedValueOnce(new Set(["logs"]));
    const entitlements = createEntitlements({ sources: [source], now: () => 0 });

    await expect(entitlements(ORG).has("logs")).rejects.toThrow("source down");

    expect(await entitlements(ORG).has("logs")).toBe(true);
  });

  it("drops the oldest organization when more than 10,000 are cached", async () => {
    const source = vi.fn(granting("logs"));
    const entitlements = createEntitlements({ sources: [source], now: () => 0 });
    for (let index = 0; index <= 10_000; index += 1) {
      await entitlements(`org-${String(index)}`).has("logs");
    }
    source.mockClear();

    await entitlements("org-0").has("logs");
    await entitlements("org-10000").has("logs");

    expect(source.mock.calls.map(([orgId]) => orgId)).toEqual(["org-0"]);
  });
});
