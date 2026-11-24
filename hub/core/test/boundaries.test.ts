import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IMPORT_RULES = new Set([
  "no-restricted-imports",
  "@typescript-eslint/no-restricted-imports",
  "import-x/no-nodejs-modules",
]);

// Lints one import as if it were in `entry` of hub/core/src, with the repository's real ESLint config.
// Typed linting parses only files that exist, hence the entries; a parse error would hide every rule, so it throws.
const findRestrictedImports = async (entry: string, specifier: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: ROOT });
  const filePath = path.join(ROOT, "hub/core/src", entry);
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
    ["#ee", "Only hub/app/src imports #ee"],
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

// A .tsx file does not exist yet, and typed linting parses only files that exist: the resolved config shows its rules
describe("hub-core .tsx web code", () => {
  const findNodeBan = async (file: string): Promise<unknown> => {
    // ESLint types the resolved config as `any`; a flat config always holds `rules`
    const config = (await new ESLint({ cwd: ROOT }).calculateConfigForFile(path.join("hub/core/src/web", file))) as {
      rules: Record<string, unknown>;
    };
    return config.rules["import-x/no-nodejs-modules"];
  };

  it("bans Node built-ins in a .tsx file of ./web", async () => {
    await expect(findNodeBan("app.tsx")).resolves.toEqual([2]);
  });

  it("leaves Node built-ins to a .test.tsx file of ./web", async () => {
    await expect(findNodeBan("__tests__/app.test.tsx")).resolves.toBeUndefined();
  });
});

// Lints `code` as if it were `file`, an existing file (typed linting parses only those), with the repository's real
// ESLint config, and returns the messages of `rule`
const lintCode = async (file: string, code: string, rule: string): Promise<string[]> => {
  const [result] = await new ESLint({ cwd: ROOT }).lintText(code, { filePath: path.join(ROOT, file) });
  const fatal = result?.messages.find((message) => message.fatal);
  if (fatal) {
    throw new Error(fatal.message);
  }
  return (result?.messages ?? []).filter((message) => message.ruleId === rule).map((message) => message.message);
};

// The selectors of `no-restricted-syntax` for a file that need not exist: the resolved config, not a lint
const syntaxBansOf = async (file: string): Promise<string[]> => {
  // ESLint types the resolved config as `any`; a flat config always holds `rules`
  const config = (await new ESLint({ cwd: ROOT }).calculateConfigForFile(path.join(ROOT, file))) as {
    rules: Record<string, [number, ...Array<{ selector: string }>] | undefined>;
  };
  return (config.rules["no-restricted-syntax"] ?? []).slice(1).map((ban) => (ban as { selector: string }).selector);
};

const GLOBAL_HANDLE = "db.global is for access/ and db/ only";
const READ_GLOBAL = "export const read = (db: { global: unknown }): unknown => db.global;\n";
const GLOBAL_SELECTOR = "MemberExpression[computed=false][property.name='global']";

describe("db.global", { timeout: 60_000 }, () => {
  it.each([
    ["a member", READ_GLOBAL],
    ["a computed member", "export const read = (db: { global: unknown }): unknown => db['global'];\n"],
    [
      "a destructuring",
      "export const read = (db: { global: unknown }): unknown => { const { global } = db; return global; };\n",
    ],
  ])("is rejected outside access/ and db/ as %s", async (_form, code) => {
    const messages = await lintCode("hub/core/src/server/app/index.ts", code, "no-restricted-syntax");

    expect(messages).toEqual([expect.stringContaining(GLOBAL_HANDLE)]);
  });

  it.each([
    "hub/core/src/server/lifecycle/__tests__/hub.test.ts",
    "hub/core/test/server/env.ts",
    "hub/debugger/src/server/index.ts",
  ])("is rejected in %s", async (file) => {
    const messages = await lintCode(file, READ_GLOBAL, "no-restricted-syntax");

    expect(messages).toEqual([expect.stringContaining(GLOBAL_HANDLE)]);
  });

  it.each([
    "hub/core/src/server/db/index.ts",
    "hub/core/src/server/db/__tests__/scope.test.ts",
    "hub/core/test/db/test-database.ts",
    "hub/core/src/server/access/index.ts",
  ])("is allowed in %s", async (file) => {
    const messages = await lintCode(file, READ_GLOBAL, "no-restricted-syntax");

    expect(messages).toEqual([]);
  });

  // Files the resolved config covers by folder, whether or not they exist yet
  it.each([
    "hub/core/src/server/db/migrator/index.ts",
    "hub/core/src/server/access/sessions/index.ts",
    "hub/core/test/db/fixture.ts",
  ])("is allowed in %s by the resolved config", async (file) => {
    await expect(syntaxBansOf(file)).resolves.not.toContain(GLOBAL_SELECTOR);
  });

  it.each([
    "hub/core/src/server/access-keys/index.ts",
    "hub/core/src/server/jobs/index.ts",
    "hub/billing/src/server/index.ts",
    "hub/app/src/index.ts",
    "ee/hub/src/server/index.ts",
  ])("is rejected in %s by the resolved config", async (file) => {
    await expect(syntaxBansOf(file)).resolves.toContain(GLOBAL_SELECTOR);
  });

  it("is left to the web code, which cannot reach the database", async () => {
    await expect(syntaxBansOf("hub/core/src/web/index.ts")).resolves.not.toContain(GLOBAL_SELECTOR);
  });

  // The rule lives in a block beside the import rules, so it must not replace what they or the shared config ban
  it("keeps the shared bans where it applies", async () => {
    const messages = await lintCode(
      "hub/core/src/server/app/index.ts",
      "export enum Mode { On }\n",
      "no-restricted-syntax",
    );

    expect(messages).toEqual([expect.stringContaining("Use a union of string literals")]);
  });

  it.each([
    ["@micafox/testkit", "Only the sandbox/ apps use @micafox/testkit"],
    ["@micafox/sdk", "hub-core imports only @micafox/protocol and @micafox/ui"],
    ["@micafox/hub-ee", "ADR 0023"],
  ])("keeps the ban on importing %s in server code", async (specifier, message) => {
    const messages = await findRestrictedImports("server/app/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });
});
