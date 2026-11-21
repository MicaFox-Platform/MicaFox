import { ESLint, type Linter } from "eslint";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import config from "../eslint/index.js";

// Fixtures of a project linted with the preset alone: import-x needs its package.json, and the project service its
// tsconfig.json to type each file
const FIXTURES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", type: "module" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx", noEmit: true } }),
  "floating.tsx": "export const load = async (): Promise<number> => 1;\n\nvoid load;\nPromise.resolve(1);\n",
  "counter.tsx": [
    'import { useState } from "react";',
    "",
    "export const Counter = ({ isShown }: { isShown: boolean }): null => {",
    "  if (isShown) {",
    "    useState(0);",
    "  }",
    "  return null;",
    "};",
    "",
  ].join("\n"),
  "names.tsx": "export const Button = (): null => null;\n\nexport const Limits = { max: 1 };\n",
  "fixtures.ts":
    "const useFakeHubs = (): number => 1;\n\nexport const hubs = useFakeHubs();\n\nexport const Button = (): null => null;\n",
  "button.test.tsx": 'import { it } from "vitest";\n\nit.skip("renders", () => {\n  void 0;\n});\n',
};

let dir: string;
let results: Map<string, Linter.LintMessage[]>;

const rulesIn = (file: string): Array<string | null> =>
  (results.get(file) ?? []).map((message) => message.ruleId).filter((ruleId) => ruleId !== null);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "micafox-eslint-"));
  await Promise.all(Object.entries(FIXTURES).map(([file, text]) => writeFile(path.join(dir, file), text)));
  const eslint = new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: config });
  const lintResults = await eslint.lintFiles(["*.ts", "*.tsx"]);
  results = new Map(lintResults.map((result) => [path.basename(result.filePath), result.messages]));
}, 90_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("eslint preset", () => {
  it("lints a .tsx file with type information", () => {
    expect(rulesIn("floating.tsx")).toContain("@typescript-eslint/no-floating-promises");
  });

  it("reports a hook called conditionally in a .tsx file", () => {
    expect(rulesIn("counter.tsx")).toContain("react-hooks/rules-of-hooks");
  });

  it("accepts a PascalCase component but not a PascalCase data constant in a .tsx file", () => {
    const naming = (results.get("names.tsx") ?? []).filter(
      (message) => message.ruleId === "@typescript-eslint/naming-convention",
    );

    expect(naming.map((message) => message.line)).toEqual([3]);
  });

  it("applies neither the hooks rules nor PascalCase components to a .ts file", () => {
    expect(rulesIn("fixtures.ts")).toEqual(["@typescript-eslint/naming-convention"]);
  });

  it("applies the Vitest rules to a .test.tsx file", () => {
    expect(rulesIn("button.test.tsx")).toContain("vitest/no-disabled-tests");
  });

  it("parses every fixture", () => {
    const fatal = [...results.values()].flat().filter((message) => message.fatal);

    expect(fatal).toEqual([]);
  });
});
