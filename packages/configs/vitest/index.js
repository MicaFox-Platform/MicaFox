import { configDefaults, defineProject } from "vitest/config";

/** @param {string[]} conditions */
const conditionsResolve = (conditions) => {
  if (conditions.length === 0) {
    return {};
  }

  // Setting conditions replaces Vite's defaults, hence each environment's defaults follow the given conditions
  return {
    resolve: { conditions: [...conditions, "module", "browser", "development|production"] },
    ssr: { resolve: { conditions: [...conditions, "module", "node", "development|production"] } },
  };
};

// Per-project config: each workspace builds (or merges) it in its own `vitest.config.ts`
/** @type {typeof import("./index.js").createVitestConfig} */
export const createVitestConfig = ({ sourceCondition, conditions = [] } = {}) =>
  defineProject({
    ...conditionsResolve([...(sourceCondition ? [sourceCondition] : []), ...conditions]),
    test: {
      include: ["**/*.test.ts", "**/*.test.tsx"],
      exclude: [...configDefaults.exclude, "**/dist/**"],
    },
  });

export default createVitestConfig();
