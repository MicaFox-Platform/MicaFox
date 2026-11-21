import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IMPORT_RULES = new Set(["no-restricted-imports", "@typescript-eslint/no-restricted-imports"]);

// Lints one import as if it were in packages/ui/src/index.ts, with the repository's real ESLint config.
// Typed linting parses only files that exist, hence the entry; a parse error would hide every rule, so it throws.
const findRestrictedImports = async (specifier: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: ROOT });
  const filePath = path.join(ROOT, "packages/ui/src/index.ts");
  const [result] = await eslint.lintText(`import "${specifier}";\n`, { filePath });
  const fatal = result?.messages.find((message) => message.fatal);
  if (fatal) {
    throw new Error(fatal.message);
  }
  return (result?.messages ?? [])
    .filter((message) => IMPORT_RULES.has(message.ruleId ?? ""))
    .map((message) => message.message);
};

// The first lint builds a type-checked program, which takes longer than Vitest's default timeout
describe("ui imports", { timeout: 60_000 }, () => {
  it.each(["@micafox/protocol", "@micafox/hub-core/web", "@micafox/hub"])("rejects %s", async (specifier) => {
    const messages = await findRestrictedImports(specifier);

    expect(messages).toEqual([expect.stringContaining("@micafox/ui imports no @micafox package")]);
  });

  it.each(["#ee/web", "@micafox/hub-ee"])("rejects the ee/ extension: %s", async (specifier) => {
    const messages = await findRestrictedImports(specifier);

    expect(messages).toContainEqual(expect.stringContaining("ADR 0023"));
  });

  it.each(["react", "./components/index.js"])("allows %s", async (specifier) => {
    const messages = await findRestrictedImports(specifier);

    expect(messages).toEqual([]);
  });
});

// A .tsx file does not exist yet, and typed linting parses only files that exist: the resolved config shows its rules
describe("ui .tsx imports", () => {
  it("bans the test kit in a .tsx component", async () => {
    // ESLint types the resolved config as `any`; a flat config always holds `rules`
    const config = (await new ESLint({ cwd: ROOT }).calculateConfigForFile(
      "packages/ui/src/components/button.tsx",
    )) as { rules: Record<string, unknown> };

    expect(config.rules["no-restricted-imports"]).toEqual([
      2,
      { paths: [expect.objectContaining({ name: "@micafox/testkit" })] },
    ]);
  });
});
