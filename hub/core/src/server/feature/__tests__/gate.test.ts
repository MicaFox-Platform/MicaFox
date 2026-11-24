import { describe, expect, it, vi } from "vitest";

import { emptyFeature, paidFeature } from "../../../../test/feature/fixtures.js";
import { createEntitlements } from "../../access/index.js";
import type { EntitlementSource } from "../../access/index.js";
import { defineExtension } from "../contract.js";
import { createGate } from "../gate.js";
import { createFeatureRegistry } from "../registry.js";

const protocol = (module: string): { module: string; state: () => Promise<[]>; onMessage: () => Promise<void> } => ({
  module,
  state: async () => await Promise.resolve([]),
  onMessage: async () => {
    await Promise.resolve();
  },
});

const build = (sources: readonly EntitlementSource[] = []) => {
  const extension = defineExtension({
    features: [paidFeature("fixture", { protocol: protocol("fixture-module") })],
    sources,
  });
  const registry = createFeatureRegistry([emptyFeature("debugger", { protocol: protocol("debugger") })], extension);
  return createGate(registry, createEntitlements({ sources, now: Date.now }));
};

const ORG = "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01";

describe("createGate", () => {
  it("refuses an extension feature and its SDK module in S2, which has no source", async () => {
    const gate = build();

    expect([await gate.isEntitled(ORG, "fixture"), await gate.isModuleEntitled(ORG, "fixture-module")]).toEqual([
      false,
      false,
    ]);
  });

  it("lets a core feature and its module through without asking a source", async () => {
    const source = vi.fn<EntitlementSource>(async () => await Promise.resolve(new Set<string>()));
    const gate = build([source]);

    expect([await gate.isEntitled(ORG, "debugger"), await gate.isModuleEntitled(ORG, "debugger")]).toEqual([
      true,
      true,
    ]);
    expect(source).not.toHaveBeenCalled();
  });

  it("lets an extension feature through for an organization whose source grants its entitlement", async () => {
    const gate = build([async () => await Promise.resolve(new Set(["fixture-plan"]))]);

    expect([await gate.isEntitled(ORG, "fixture"), await gate.isModuleEntitled(ORG, "fixture-module")]).toEqual([
      true,
      true,
    ]);
  });

  it("refuses a feature the hub does not run and a module no feature serves", async () => {
    const gate = build();

    expect([await gate.isEntitled(ORG, "unknown"), await gate.isModuleEntitled(ORG, "unknown")]).toEqual([
      false,
      false,
    ]);
  });

  it("throws when a source fails, so a broken source never lets a paid part through", async () => {
    const gate = build([async () => await Promise.reject(new Error("source down"))]);

    await expect(gate.isEntitled(ORG, "fixture")).rejects.toThrow("source down");
  });
});
