import { describe, expect, it } from "vitest";

import { emptyFeature, paidFeature } from "../../../../test/feature/fixtures.js";
import type { Migration } from "../../db/index.js";
import { defineExtension } from "../contract.js";
import type { Feature } from "../contract.js";
import { createFeatureRegistry, FeatureRegistryError } from "../registry.js";

const migration = (name: string): Migration => ({
  name,
  up: async () => {
    await Promise.resolve();
  },
});
const job = (name: string): { name: string; everyMs: number; run: () => Promise<void> } => ({
  name,
  everyMs: 60_000,
  run: async () => {
    await Promise.resolve();
  },
});
const retention = (name: string): { name: string; maxAgeDays: number; run: () => Promise<void> } => ({
  name,
  maxAgeDays: 30,
  run: async () => {
    await Promise.resolve();
  },
});
const protocol = (module: string): { module: string; state: () => Promise<[]>; onMessage: () => Promise<void> } => ({
  module,
  state: async () => await Promise.resolve([]),
  onMessage: async () => {
    await Promise.resolve();
  },
});

// The error with exactly these problems, in order
const withProblems = (problems: readonly string[]): unknown => expect.objectContaining({ problems });

describe("createFeatureRegistry", () => {
  it("names both features that share a name, also across the app and the extension", () => {
    expect(() =>
      createFeatureRegistry(
        [emptyFeature("debugger"), emptyFeature("debugger")],
        defineExtension({ features: [paidFeature("logs"), paidFeature("logs")] }),
      ),
    ).toThrow(withProblems(['Two features are named "debugger"', 'Two features are named "logs"']));
  });

  it("names the two features that serve one SDK module", () => {
    expect(() =>
      createFeatureRegistry(
        [
          emptyFeature("debugger", { protocol: protocol("debugger") }),
          emptyFeature("probes", { protocol: protocol("debugger") }),
        ],
        undefined,
      ),
    ).toThrow(withProblems(['The features "debugger" and "probes" both have the SDK module "debugger"']));
  });

  it("names the two features that share a job or a retention name", () => {
    expect(() =>
      createFeatureRegistry(
        [
          emptyFeature("debugger", { jobs: [job("expire")], retention: [retention("snapshots")] }),
          emptyFeature("probes", { jobs: [job("expire")], retention: [retention("snapshots")] }),
        ],
        undefined,
      ),
    ).toThrow(
      withProblems([
        'The features "debugger" and "probes" both have the job "expire"',
        'The features "debugger" and "probes" both have the retention policy "snapshots"',
      ]),
    );
  });

  it("names the feature that has two migrations of one name, but lets two features reuse one", () => {
    const features = [
      emptyFeature("debugger", { migrations: [migration("0001-init"), migration("0001-init")] }),
      emptyFeature("probes", { migrations: [migration("0001-init")] }),
    ];

    expect(() => createFeatureRegistry(features, undefined)).toThrow(
      withProblems(['The feature "debugger" has two migrations named "0001-init"']),
    );
  });

  it("refuses a name that is not lowercase letters, digits and dashes, and the names the core uses", () => {
    expect(() =>
      createFeatureRegistry([emptyFeature("Debugger"), emptyFeature("projects"), emptyFeature("me")], undefined),
    ).toThrow(
      withProblems([
        'The feature name "Debugger" is not lowercase letters, digits and dashes, from a letter',
        'The feature name "projects" is the core\'s own: choose another',
        'The feature name "me" is the core\'s own: choose another',
      ]),
    );
  });

  it("refuses a core feature with an entitlement and an extension feature without one", () => {
    const declaring: Feature & { entitlement: string } = { ...emptyFeature("debugger"), entitlement: "pro" };
    expect(() =>
      createFeatureRegistry([declaring], defineExtension({ features: [{ ...paidFeature("logs"), entitlement: "" }] })),
    ).toThrow(
      withProblems([
        'The core feature "debugger" declares an entitlement: only extension features do',
        'The extension feature "logs" has no entitlement',
      ]),
    );
  });

  it("refuses a job that never runs and a retention that keeps nothing", () => {
    expect(() =>
      createFeatureRegistry(
        [
          emptyFeature("debugger", {
            jobs: [{ ...job("expire"), everyMs: 0 }],
            retention: [{ ...retention("snapshots"), maxAgeDays: 1.5 }],
          }),
        ],
        undefined,
      ),
    ).toThrow(
      withProblems([
        'The job "expire" of "debugger" needs a whole number of milliseconds above 0',
        'The retention policy "snapshots" of "debugger" needs a whole number of days above 0',
      ]),
    );
  });

  it("reports every problem at once, each on its own line", () => {
    const error = new FeatureRegistryError(["one", "two"]);

    expect(error.report()).toBe("micafox-hub: the features are not valid, nothing was started:\n  one\n  two");
  });

  it("orders migrations core features first, then the extension's, only for features that have some", () => {
    const registry = createFeatureRegistry(
      [emptyFeature("debugger", { migrations: [migration("0001-init")] }), emptyFeature("probes")],
      defineExtension({ features: [paidFeature("logs", { migrations: [migration("0001-logs")] })] }),
    );

    expect(registry.migrations.map(({ name, migrations }) => [name, migrations.map((entry) => entry.name)])).toEqual([
      ["debugger", ["0001-init"]],
      ["logs", ["0001-logs"]],
    ]);
  });

  it("tags jobs, retention policies and modules with their feature and entitlement", () => {
    const registry = createFeatureRegistry(
      [emptyFeature("debugger", { jobs: [job("expire")], protocol: protocol("debugger") })],
      defineExtension({ features: [paidFeature("logs", { retention: [retention("log-lines")] })] }),
    );

    expect([
      registry.jobs.map(({ feature, entitlement, part }) => [feature, entitlement, part.name]),
      registry.retention.map(({ feature, entitlement, part }) => [feature, entitlement, part.name]),
      registry.modules.map(({ feature, entitlement, part }) => [feature, entitlement, part.module]),
    ]).toEqual([
      [["debugger", undefined, "expire"]],
      [["logs", "logs-plan", "log-lines"]],
      [["debugger", undefined, "debugger"]],
    ]);
  });
});
