// The one source of the build condition (app.md#building): scripts/build.ts gives it to esbuild, vitest.config.ts to
// Vitest, and nodeConditionFlags() to `node --conditions`. tsconfig.open-core.json repeats it for tsc, which reads
// only JSON; a test keeps the two equal.

/** The two builds of the hub: with `ee/` (default) or the basic hub. */
export type HubBuild = "hub" | "basic-hub";

/** Under this condition `#ee` and `#ee/web` resolve to the empty stubs: the basic hub (ADR 0023). */
export const OPEN_CORE_CONDITION = "micafox-open-core";

/** `EE` holds a value that names no build; failing beats silently building the paid one. */
export class BuildFlagError extends Error {
  constructor(value: string) {
    super(`EE must be unset, "true" or "false", not ${JSON.stringify(value)}`);
    this.name = "BuildFlagError";
  }
}

/** The build `EE` selects: unset or `"true"` the hub, `"false"` the basic hub; throws `BuildFlagError` otherwise. */
export const buildOf = (env: Readonly<Record<string, string | undefined>>): HubBuild => {
  const value = env.EE;
  if (value === undefined || value === "true") {
    return "hub";
  }
  if (value === "false") {
    return "basic-hub";
  }
  throw new BuildFlagError(value);
};

/** The export conditions of a build, added to each tool's defaults. */
export const conditionsOf = (build: HubBuild): string[] => (build === "basic-hub" ? [OPEN_CORE_CONDITION] : []);

/** The `--conditions` flags that make `node` resolve as the build does. */
export const nodeConditionFlags = (build: HubBuild): string[] =>
  conditionsOf(build).map((condition) => `--conditions=${condition}`);

// The names of the globals the sources declare, which esbuild and Vite match as written
const BUILD_GLOBAL = "MICAFOX_HUB_BUILD";
const VERSION_GLOBAL = "MICAFOX_HUB_VERSION";

/** The globals esbuild and Vitest replace in the sources: the hub's version and build, as JavaScript literals. */
export const buildDefines = (build: HubBuild, version: string): Record<string, string> =>
  Object.fromEntries([
    [BUILD_GLOBAL, JSON.stringify(build)],
    [VERSION_GLOBAL, JSON.stringify(version)],
  ]);
