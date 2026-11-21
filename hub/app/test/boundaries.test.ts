// The app's row of the dependency matrix (docs/architecture/overview.md#packages), its browser entry, the ee/ rule,
// which holds in every folder and has its one exception here, and the rows no package of their own proves yet: the
// SDK's, the sandbox ban and ee/. The other packages prove their own rows in their test/boundaries.test.ts.

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
  it.each(["#ee", "#ee/web"])("allows %s in hub/app/src", async (specifier) => {
    const messages = await findRestrictedImports("hub/app/src/index.ts", specifier);

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
    const messages = await findRestrictedImports("hub/app/src/index.ts", specifier);

    expect(messages).toEqual([]);
  });

  it.each([
    "@micafox/hub-ee",
    "@micafox/hub-ee/web",
    "../../ee/hub/src/server/index.js",
    "../../../ee/hub/src/index.js",
  ])("rejects the ee/ extension other than through #ee: %s", async (specifier) => {
    const messages = await findRestrictedImports("hub/app/src/index.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining("only as #ee or #ee/web"));
  });

  it.each(["@micafox/sdk", "@micafox/configs/vitest"])("rejects %s", async (specifier) => {
    const messages = await findRestrictedImports("hub/app/src/index.ts", specifier);

    expect(messages).toEqual([expect.stringContaining("hub/app imports the protocol, ui and the hub packages")]);
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
    const messages = await findRestrictedImports("hub/app/src/web/ee-stub.ts", specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });

  it.each(["#ee/web", "@micafox/hub-core/web", "@micafox/hub-debugger/web", "@micafox/ui", "./features.js"])(
    "allows %s",
    async (specifier) => {
      const messages = await findRestrictedImports("hub/app/src/web/ee-stub.ts", specifier);

      expect(messages).toEqual([]);
    },
  );
});

describe("imports of the hub app", { timeout: 60_000 }, () => {
  it.each([
    ["sandbox/frameworks/fastify/src/index.ts", "@micafox/hub"],
    ["sandbox/frameworks/fastify/src/index.ts", "@micafox/hub/cli"],
  ])("rejects in %s: %s", async (file, specifier) => {
    const messages = await findRestrictedImports(file, specifier);

    expect(messages).toEqual([expect.stringContaining("Nothing imports the hub app but tools/testkit")]);
  });

  it.each(["@micafox/hub", "@micafox/hub/web"])("lets the test kit import only ./cli, not %s", async (specifier) => {
    const messages = await findRestrictedImports("tools/testkit/src/hub.ts", specifier);

    expect(messages).toEqual([expect.stringContaining("only through @micafox/hub/cli")]);
  });

  it("allows the test kit to start the hub through @micafox/hub/cli", async () => {
    const messages = await findRestrictedImports("tools/testkit/src/hub.ts", "@micafox/hub/cli");

    expect(messages).toEqual([]);
  });
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

describe("product code and the sandbox", { timeout: 60_000 }, () => {
  it.each([
    ["packages/sdk/src/index.ts", "@micafox/example-fastify"],
    ["hub/core/src/server/index.ts", "@micafox/example-formats"],
  ])("rejects in %s: %s", async (file, specifier) => {
    const messages = await findRestrictedImports(file, specifier);

    expect(messages).toContainEqual(expect.stringContaining("Product code never imports sandbox/"));
  });

  it.each(["@micafox/hub", "@micafox/hub/cli", "@micafox/hub-core", "@micafox/ui", "@micafox/testkit"])(
    "rejects in the SDK: %s",
    async (specifier) => {
      const messages = await findRestrictedImports("packages/sdk/src/index.ts", specifier);

      expect(messages).toContainEqual(expect.stringContaining("@micafox/sdk imports only @micafox/protocol"));
    },
  );

  it("allows the SDK its protocol", async () => {
    const messages = await findRestrictedImports("packages/sdk/src/index.ts", "@micafox/protocol");

    expect(messages).toEqual([]);
  });
});

// Tests and configs of a folder follow its rule too, not only its sources
describe("whole folders", { timeout: 60_000 }, () => {
  it.each([
    ["packages/sdk/test/docs/connector.test.ts", "@micafox/hub-core", "packages/ never imports hub/"],
    ["packages/sdk/test/docs/connector.test.ts", "@micafox/example-fastify", "Product code never imports sandbox/"],
    ["hub/core/test/boundaries.test.ts", "@micafox/sdk", "The hub never imports the SDK"],
    ["hub/core/test/boundaries.test.ts", "@micafox/testkit", "Only the sandbox/ apps use @micafox/testkit"],
  ])("rejects in %s: %s", async (file, specifier, message) => {
    const messages = await findRestrictedImports(file, specifier);

    expect(messages).toContainEqual(expect.stringContaining(message));
  });
});

// ee/ has no file yet, and typed linting parses only files that exist: the resolved config shows its rows
describe("the ee/ rows, ready for ee/hub", () => {
  type Rules = Record<string, [number, { patterns?: Array<{ regex: string }> }?]>;

  const findRules = async (file: string): Promise<Rules> => {
    // ESLint types the resolved config as `any`; a flat config always holds `rules`
    const config = (await new ESLint({ cwd: ROOT }).calculateConfigForFile(file)) as { rules: Rules };
    return config.rules;
  };
  const isRejected = (rules: Rules, rule: string, specifier: string): boolean =>
    (rules[rule]?.[1]?.patterns ?? []).some(({ regex }) => new RegExp(regex, "u").test(specifier));

  it.each(["@micafox/hub", "@micafox/hub/cli", "@micafox/sdk", "@micafox/testkit", "@micafox/example-fastify", "#ee"])(
    "rejects %s in ee/hub",
    async (specifier) => {
      const rules = await findRules("ee/hub/src/server/index.ts");

      expect(isRejected(rules, "@typescript-eslint/no-restricted-imports", specifier)).toBe(true);
    },
  );

  it.each(["@micafox/protocol", "@micafox/ui", "@micafox/hub-core/web", "@micafox/hub-debugger/schema"])(
    "allows %s in ee/hub",
    async (specifier) => {
      const rules = await findRules("ee/hub/src/server/index.ts");

      expect(isRejected(rules, "@typescript-eslint/no-restricted-imports", specifier)).toBe(false);
    },
  );

  it.each(["../server/index.js", "@micafox/hub-core"])(
    "keeps server code out of the extension's ./web: %s",
    async (specifier) => {
      const rules = await findRules("ee/hub/src/web/index.ts");

      expect(isRejected(rules, "no-restricted-imports", specifier)).toBe(true);
    },
  );

  it("keeps Node built-ins out of the extension's ./web", async () => {
    const rules = await findRules("ee/hub/src/web/index.ts");

    expect(rules["import-x/no-nodejs-modules"]).toEqual([2]);
  });

  it.each(["../server/index.js", "../web/index.js", "@micafox/hub-core/web"])(
    "keeps server and web code out of the extension's ./schema: %s",
    async (specifier) => {
      const rules = await findRules("ee/hub/src/schema/index.ts");

      expect(isRejected(rules, "no-restricted-imports", specifier)).toBe(true);
    },
  );
});
