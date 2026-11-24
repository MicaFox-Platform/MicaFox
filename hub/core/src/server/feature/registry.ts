import type { Extension, Feature, FeatureJob, ProtocolModule, RetentionPolicy } from "./contract.js";
import type { MigrationPackage } from "../db/index.js";

/** A part of a feature with the feature it belongs to and the entitlement that gates it, if any. */
export interface Registered<T> {
  feature: string;
  entitlement: string | undefined;
  part: T;
}

/** The features of a hub, checked, with their parts in the order they register. */
export interface FeatureRegistry {
  /** The features in order: the app's, then the extension's. */
  features: ReadonlyArray<{ feature: Feature; entitlement: string | undefined }>;
  /** One package per feature that has migrations, in the features' order; hub-core's own comes before them. */
  migrations: readonly MigrationPackage[];
  jobs: ReadonlyArray<Registered<FeatureJob>>;
  retention: ReadonlyArray<Registered<RetentionPolicy>>;
  modules: ReadonlyArray<Registered<ProtocolModule>>;
}

/** Features or the extension broke a rule of the contract; holds every problem, naming the parts in conflict. */
export class FeatureRegistryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid features: ${String(problems.length)} problem(s)`);
    this.name = "FeatureRegistryError";
  }

  /** The start-up report: every problem on its own line. */
  report(): string {
    return [
      "micafox-hub: the features are not valid, nothing was started:",
      ...this.problems.map((problem) => `  ${problem}`),
    ].join("\n");
  }
}

const NAME = /^[a-z][a-z\d-]{0,39}$/;

// What core routes and actions already use: a feature of these names would shadow them, or get `<name>.<action>`
// grants to members for actions the core means for admins
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "core",
  "entitlement",
  "environment",
  "environments",
  "events",
  "instance",
  "instances",
  "internal",
  "invite",
  "invites",
  "key",
  "keys",
  "me",
  "member",
  "members",
  "openapi",
  "org",
  "orgs",
  "password-resets",
  "project",
  "projects",
  "session",
  "sessions",
  "setup",
]);

interface Entry {
  feature: Feature;
  entitlement: string | undefined;
}

// Collects every problem, and remembers which feature first used each name
interface Checker {
  problems: string[];
  claimed: Map<string, string>;
}

interface Claim {
  /** What the name names: "job", "SDK module", ... */
  kind: string;
  /** What must be unique; the scope is part of it. */
  key: string;
  /** What the report shows for it. */
  label: string;
}

const claim = (checker: Checker, name: Claim, owner: string): void => {
  const id = `${name.kind}\0${name.key}`;
  const first = checker.claimed.get(id);
  if (first === undefined) {
    checker.claimed.set(id, owner);
    return;
  }
  checker.problems.push(
    first === owner
      ? `The feature "${owner}" has two ${name.kind}s named "${name.label}"`
      : `The features "${first}" and "${owner}" both have the ${name.kind} "${name.label}"`,
  );
};

const claimName = (checker: Checker, named: { kind: string; name: string }, owner: string): void => {
  const { kind, name } = named;
  if (!NAME.test(name)) {
    checker.problems.push(
      `The ${kind} "${name}" of "${owner}" is not lowercase letters, digits and dashes, from a letter`,
    );
  }
  claim(checker, { kind, key: name, label: name }, owner);
};

const checkEntitlement = (checker: Checker, entry: Entry, isExtension: boolean): void => {
  const { name } = entry.feature;
  const declared: unknown = "entitlement" in entry.feature ? entry.feature.entitlement : undefined;
  if (!isExtension && declared !== undefined) {
    checker.problems.push(`The core feature "${name}" declares an entitlement: only extension features do`);
  }
  if (isExtension && (typeof declared !== "string" || declared === "")) {
    checker.problems.push(`The extension feature "${name}" has no entitlement`);
  }
};

const checkFeatureName = (checker: Checker, name: string): void => {
  if (RESERVED_NAMES.has(name)) {
    checker.problems.push(`The feature name "${name}" is the core's own: choose another`);
  }
  if (!NAME.test(name)) {
    checker.problems.push(`The feature name "${name}" is not lowercase letters, digits and dashes, from a letter`);
  }
  const id = `feature\0${name}`;
  if (checker.claimed.has(id)) {
    checker.problems.push(`Two features are named "${name}"`);
  }
  checker.claimed.set(id, name);
};

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

// A timer fires at once for a longer delay, which would run the job in a loop
const MAX_TIMER_MS = 2_147_483_647;

const checkJobs = (checker: Checker, feature: Feature): void => {
  for (const job of feature.jobs ?? []) {
    claimName(checker, { kind: "job", name: job.name }, feature.name);
    if (!isPositiveInteger(job.everyMs) || job.everyMs > MAX_TIMER_MS) {
      checker.problems.push(
        `The job "${job.name}" of "${feature.name}" needs a whole number of milliseconds from 1 to ${String(MAX_TIMER_MS)}`,
      );
    }
  }
};

const checkRetention = (checker: Checker, feature: Feature): void => {
  for (const policy of feature.retention ?? []) {
    claimName(checker, { kind: "retention policy", name: policy.name }, feature.name);
    if (!isPositiveInteger(policy.maxAgeDays)) {
      checker.problems.push(
        `The retention policy "${policy.name}" of "${feature.name}" needs a whole number of days above 0`,
      );
    }
  }
};

const checkParts = (checker: Checker, feature: Feature): void => {
  for (const migration of feature.migrations ?? []) {
    claim(
      checker,
      { kind: "migration", key: `${feature.name}/${migration.name}`, label: migration.name },
      feature.name,
    );
  }
  checkJobs(checker, feature);
  checkRetention(checker, feature);
  if (feature.protocol !== undefined) {
    const { module } = feature.protocol;
    claim(checker, { kind: "SDK module", key: module, label: module }, feature.name);
  }
};

const listParts = <T>(entries: readonly Entry[], pick: (feature: Feature) => readonly T[]): Array<Registered<T>> =>
  entries.flatMap(({ feature, entitlement }) =>
    pick(feature).map((part) => ({ feature: feature.name, entitlement, part })),
  );

/**
 * Checks `features` and `extension` and orders their parts; throws a `FeatureRegistryError` with every problem
 * when two features share a name, an SDK module, or a job, retention or migration name, or a name is not valid.
 */
export const createFeatureRegistry = (
  features: readonly Feature[],
  extension: Extension | undefined,
): FeatureRegistry => {
  const checker: Checker = { problems: [], claimed: new Map() };
  const entries: Entry[] = [
    ...features.map((feature) => ({ feature, entitlement: undefined })),
    ...(extension?.features ?? []).map((feature) => ({ feature, entitlement: feature.entitlement })),
  ];
  entries.forEach((entry, index) => {
    checkFeatureName(checker, entry.feature.name);
    checkEntitlement(checker, entry, index >= features.length);
    checkParts(checker, entry.feature);
  });
  if (checker.problems.length > 0) {
    throw new FeatureRegistryError(checker.problems);
  }
  return {
    features: entries,
    migrations: entries
      .filter(({ feature }) => (feature.migrations?.length ?? 0) > 0)
      .map(({ feature }) => ({ name: feature.name, migrations: feature.migrations ?? [] })),
    jobs: listParts(entries, (feature) => feature.jobs ?? []),
    retention: listParts(entries, (feature) => feature.retention ?? []),
    modules: listParts(entries, (feature) => (feature.protocol === undefined ? [] : [feature.protocol])),
  };
};
