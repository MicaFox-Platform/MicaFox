import { configDefaults, defineProject } from "vitest/config";

/** @param {string | undefined} sourceCondition */
const sourceResolve = (sourceCondition) => {
  if (!sourceCondition) {
    return {};
  }

  // Setting conditions replaces Vite's defaults, hence each environment's defaults follow the source condition
  return {
    resolve: { conditions: [sourceCondition, "module", "browser", "development|production"] },
    ssr: { resolve: { conditions: [sourceCondition, "module", "node", "development|production"] } },
  };
};

// Per-project config: each workspace builds (or merges) it in its own `vitest.config.ts`
/** @type {typeof import("./index.js").createVitestConfig} */
export const createVitestConfig = ({ sourceCondition } = {}) =>
  defineProject({
    ...sourceResolve(sourceCondition),
    test: {
      include: ["**/*.test.ts", "**/*.test.tsx"],
      exclude: [...configDefaults.exclude, "**/dist/**"],
    },
  });

export default createVitestConfig();
