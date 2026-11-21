import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IMPORT_RULES = new Set([
  "no-restricted-imports",
  "@typescript-eslint/no-restricted-imports",
  "import-x/no-nodejs-modules",
]);
const FEATURE_MESSAGE = "A hub feature imports only @micafox/protocol, hub-core and ui, never another feature";

// Lints one import as if it were in `entry` of hub/debugger/src, with the repository's real ESLint config.
// Typed linting parses only files that exist, hence the entries; a parse error would hide every rule, so it throws.
const findRestrictedImports = async (entry: string, specifier: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: ROOT });
  const filePath = path.join(ROOT, "hub/debugger/src", entry);
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
describe("hub-debugger imports", { timeout: 60_000 }, () => {
  it.each(["@micafox/hub-logpoints", "@micafox/hub-logpoints/schema", "@micafox/hub", "@micafox/sdk"])(
    "rejects %s",
    async (specifier) => {
      const messages = await findRestrictedImports("server/index.ts", specifier);

      expect(messages).toEqual([expect.stringContaining(FEATURE_MESSAGE)]);
    },
  );

  it.each(["@micafox/hub-ee", "@micafox/hub-ee/server", "#ee", "../../../../ee/hub/src/server/index.js"])(
    "rejects the ee/ extension: %s",
    async (specifier) => {
      const messages = await findRestrictedImports("server/index.ts", specifier);

      expect(messages).toContainEqual(expect.stringContaining("ADR 0023"));
    },
  );

  it.each(["@micafox/hub-core", "@micafox/hub-core/schema", "@micafox/protocol", "@micafox/ui", "node:crypto"])(
    "allows %s",
    async (specifier) => {
      const messages = await findRestrictedImports("server/index.ts", specifier);

      expect(messages).toEqual([]);
    },
  );
});

describe("hub-debugger web imports", { timeout: 60_000 }, () => {
  it.each([
    ["../server/index.js", "./web and ./schema never import server code"],
    ["../server/intake/index.js", "./web and ./schema never import server code"],
    ["node:path", "Do not import Node.js builtin module"],
    ["path", "Do not import Node.js builtin module"],
    ["@micafox/hub-core", "A package's root entry is its server code"],
  ])("rejects server code: %s", async (specifier, message) => {
    const messages = await findRestrictedImports("web/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });

  // The web rules and the dependency table are separate rules, so one does not replace the other
  it("still rejects another feature", async () => {
    const messages = await findRestrictedImports("web/index.ts", "@micafox/hub-logpoints/web");

    expect(messages).toEqual([expect.stringContaining(FEATURE_MESSAGE)]);
  });

  it.each(["@micafox/hub-core/web", "@micafox/hub-core/schema", "@micafox/ui", "../schema/index.js"])(
    "allows %s",
    async (specifier) => {
      const messages = await findRestrictedImports("web/index.ts", specifier);

      expect(messages).toEqual([]);
    },
  );
});

describe("hub-debugger schema imports", { timeout: 60_000 }, () => {
  it.each([
    ["../server/index.js", "./web and ./schema never import server code"],
    ["../web/index.js", "it never imports ./web"],
    ["node:util", "Do not import Node.js builtin module"],
    ["@micafox/hub-core", "A package's root entry is its server code"],
    ["@micafox/hub-core/web", "it never imports a ./web entry"],
  ])("rejects %s", async (specifier, message) => {
    const messages = await findRestrictedImports("schema/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });

  it.each(["@micafox/hub-core/schema", "@micafox/protocol"])("allows %s", async (specifier) => {
    const messages = await findRestrictedImports("schema/index.ts", specifier);

    expect(messages).toEqual([]);
  });
});
