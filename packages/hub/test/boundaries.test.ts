// The app's row of the hub's dependency rule, its browser entry, and the ee/ rule, which holds in every package and
// has its one exception here. The other packages prove their own rows in their test/boundaries.test.ts.

import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IMPORT_RULES = new Set([
  "no-restricted-imports",
  "@typescript-eslint/no-restricted-imports",
  "import-x/no-nodejs-modules",
]);

// Lints one import as if it were in `file` of the repository, with its real ESLint config.
// Typed linting parses only files that exist; a parse error would hide every rule, so it throws.
const findRestrictedImports = async (file: string, specifier: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(`import "${specifier}";\n`, { filePath: path.join(ROOT, file) });
  const fatal = result?.messages.find((message) => message.fatal);
  if (fatal) {
    throw new Error(fatal.message);
  }
  return (result?.messages ?? [])
    .filter((message) => IMPORT_RULES.has(message.ruleId ?? ""))
    .map((message) => message.message);
};

// The first lint builds a type-checked program, which takes longer than Vitest's default timeout
describe("hub app imports", { timeout: 60_000 }, () => {
  it.each(["#ee", "#ee/web"])("allows %s in packages/hub/src", async (specifier) => {
    const messages = await findRestrictedImports("packages/hub/src/index.ts", specifier);

    expect(messages).toEqual([]);
  });

  it.each([
    "@micafox/hub-core",
    "@micafox/hub-core/web",
    "@micafox/hub-debugger",
    "@micafox/hub-debugger/web",
    "@micafox/ui",
    "@micafox/protocol",
    "node:util",
  ])("allows %s", async (specifier) => {
    const messages = await findRestrictedImports("packages/hub/src/index.ts", specifier);

    expect(messages).toEqual([]);
  });

  it.each([
    "@micafox/hub-ee",
    "@micafox/hub-ee/web",
    "../../ee/hub/src/server/index.js",
    "../../../ee/hub/src/index.js",
  ])("rejects the ee/ extension other than through #ee: %s", async (specifier) => {
    const messages = await findRestrictedImports("packages/hub/src/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining("only as #ee or #ee/web"));
  });

  it.each(["@micafox/sdk", "@micafox/configs/vitest"])("rejects %s", async (specifier) => {
    const messages = await findRestrictedImports("packages/hub/src/index.ts", specifier);

    expect(messages).toEqual([expect.stringContaining("The hub app imports the hub packages and the protocol")]);
  });
});

describe("hub app web imports", { timeout: 60_000 }, () => {
  it.each([
    ["#ee", "#ee is the server extension"],
    ["../index.js", "the files above it are the app's server code"],
    ["../features.js", "the files above it are the app's server code"],
    ["@micafox/hub-core", "A package's root entry is its server code"],
    ["@micafox/hub-debugger", "A package's root entry is its server code"],
    ["node:fs", 'Do not import Node.js builtin module "node:fs"'],
    ["fs", 'Do not import Node.js builtin module "fs"'],
  ])("rejects %s", async (specifier, message) => {
    const messages = await findRestrictedImports("packages/hub/src/web/ee-stub.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });

  it.each(["#ee/web", "@micafox/hub-core/web", "@micafox/hub-debugger/web", "@micafox/ui", "./features.js"])(
    "allows %s",
    async (specifier) => {
      const messages = await findRestrictedImports("packages/hub/src/web/ee-stub.ts", specifier);

      expect(messages).toEqual([]);
    },
  );
});

describe("ee/ outside the hub app", { timeout: 60_000 }, () => {
  it.each([
    ["packages/sdk/src/index.ts", "#ee"],
    ["packages/sdk/src/index.ts", "@micafox/hub-ee"],
    ["packages/ui/src/index.ts", "#ee/web"],
    ["tools/testkit/src/hub.ts", "../../../ee/hub/src/server/index.js"],
  ])("rejects in %s: %s", async (file, specifier) => {
    const messages = await findRestrictedImports(file, specifier);

    expect(messages).toContainEqual(expect.stringContaining("ADR 0023"));
  });
});
