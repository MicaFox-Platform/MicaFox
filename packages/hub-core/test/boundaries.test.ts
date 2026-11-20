import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IMPORT_RULES = new Set([
  "no-restricted-imports",
  "@typescript-eslint/no-restricted-imports",
  "import-x/no-nodejs-modules",
]);

// Lints one import as if it were in `entry` of packages/hub-core/src, with the repository's real ESLint config.
// Typed linting parses only files that exist, hence the entries; a parse error would hide every rule, so it throws.
const findRestrictedImports = async (entry: string, specifier: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: ROOT });
  const filePath = path.join(ROOT, "packages/hub-core/src", entry);
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
describe("hub-core imports", { timeout: 60_000 }, () => {
  it.each([
    ["@micafox/hub-debugger", "hub-core imports only @micafox/protocol and @micafox/ui"],
    ["@micafox/hub-debugger/web", "hub-core imports only @micafox/protocol and @micafox/ui"],
    ["@micafox/hub", "hub-core imports only @micafox/protocol and @micafox/ui"],
    ["@micafox/sdk", "hub-core imports only @micafox/protocol and @micafox/ui"],
    ["@micafox/hub-ee", "ADR 0023"],
    ["#ee", "Only packages/hub/src imports #ee"],
    ["../../../../ee/hub/src/server/index.js", "ADR 0023"],
  ])("rejects %s", async (specifier, message) => {
    const messages = await findRestrictedImports("server/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });

  it.each(["@micafox/protocol", "@micafox/ui", "@micafox/ui/tokens.css", "node:http", "./feature/index.js"])(
    "allows %s",
    async (specifier) => {
      const messages = await findRestrictedImports("server/index.ts", specifier);

      expect(messages).toEqual([]);
    },
  );
});

describe("hub-core web imports", { timeout: 60_000 }, () => {
  it.each([
    ["../server/index.js", "./web and ./schema never import server code"],
    ["../server/db/index.js", "./web and ./schema never import server code"],
    ["node:fs", "Do not import Node.js builtin module"],
    ["fs", "Do not import Node.js builtin module"],
    ["@micafox/hub-core", "A package's root entry is its server code"],
  ])("rejects server code: %s", async (specifier, message) => {
    const messages = await findRestrictedImports("web/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });

  // The web rules and the dependency table are separate rules, so one does not replace the other
  it("still rejects a package the dependency table forbids", async () => {
    const messages = await findRestrictedImports("web/index.ts", "@micafox/hub-debugger/web");

    expect(messages).toEqual([expect.stringContaining("hub-core imports only @micafox/protocol and @micafox/ui")]);
  });

  it.each(["@micafox/ui", "@micafox/protocol", "../schema/index.js", "./feature/index.js"])(
    "allows %s",
    async (specifier) => {
      const messages = await findRestrictedImports("web/index.ts", specifier);

      expect(messages).toEqual([]);
    },
  );
});

describe("hub-core schema imports", { timeout: 60_000 }, () => {
  it.each([
    ["../server/index.js", "./web and ./schema never import server code"],
    ["../web/index.js", "it never imports ./web"],
    ["node:crypto", "Do not import Node.js builtin module"],
    ["@micafox/hub-core", "A package's root entry is its server code"],
    ["@micafox/hub-core/web", "it never imports a ./web entry"],
  ])("rejects %s", async (specifier, message) => {
    const messages = await findRestrictedImports("schema/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });

  it.each(["@micafox/protocol", "./breakpoint.js"])("allows %s", async (specifier) => {
    const messages = await findRestrictedImports("schema/index.ts", specifier);

    expect(messages).toEqual([]);
  });
});
