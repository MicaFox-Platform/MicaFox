import type { UserWorkspaceConfig } from "vitest/config";

/** Options of `createVitestConfig()`. */
export interface VitestConfigOptions {
  /** Export condition resolved before Vite's defaults, so tests import workspace sources without a build. */
  sourceCondition?: string;
  /** More export conditions, such as a build variant's, resolved after `sourceCondition` and before Vite's defaults. */
  conditions?: readonly string[];
}

/** Builds the Vitest project config: runs every `.test.ts` file and skips `dist/`. */
export declare const createVitestConfig: (options?: VitestConfigOptions) => UserWorkspaceConfig;

/** The result of `createVitestConfig()` without options. */
declare const config: UserWorkspaceConfig;
export default config;
