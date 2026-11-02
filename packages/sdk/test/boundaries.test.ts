import { ESLint } from "eslint";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");

// Lints one import as if it were in `file` of packages/sdk/src, with the repository's real ESLint config
const findRestrictedImports = async (file: string, specifier: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: ROOT });
  const filePath = path.join(ROOT, "packages/sdk/src", file);
  const results = await eslint.lintText(`import "${specifier}";\n`, { filePath });
  return results.flatMap((result) =>
    result.messages.filter((message) => message.ruleId === "no-restricted-imports").map((message) => message.message),
  );
};

// The first lint builds a type-checked program, which takes longer than Vitest's default timeout
describe("connector imports", { timeout: 60_000 }, () => {
  it.each([
    "@probex-platform/protocol/src/index.js",
    "@probex-platform/sdk",
    "ws/lib/websocket.js",
    "undici",
    "util",
    "../logger/logger.js",
    "../debugger/index.js",
    "./../logger/index.js",
    "./options/config.js",
  ])("rejects %s in a root file", async (specifier) => {
    const messages = await findRestrictedImports("connector/index.ts", specifier);

    expect(messages).toHaveLength(1);
  });

  it.each(["@probex-platform/protocol", "ws", "../logger/index.js", "node:os", "./hub-connector/index.js"])(
    "allows %s in a root file",
    async (specifier) => {
      const messages = await findRestrictedImports("connector/index.ts", specifier);

      expect(messages).toEqual([]);
    },
  );

  it.each([
    "undici",
    "../options/config.js",
    "./../options/index.js",
    "../index.js",
    "../../logger/logger.js",
    "../../debugger/index.js",
  ])("rejects %s in a sub-component", async (specifier) => {
    const messages = await findRestrictedImports("connector/outbound/batcher.ts", specifier);

    expect(messages).toHaveLength(1);
  });

  it.each([
    "@probex-platform/protocol",
    "ws",
    "node:buffer",
    "./queues.js",
    "../options/index.js",
    "../../logger/index.js",
  ])("allows %s in a sub-component", async (specifier) => {
    const messages = await findRestrictedImports("connector/outbound/batcher.ts", specifier);

    expect(messages).toEqual([]);
  });
});

describe("logger imports", { timeout: 60_000 }, () => {
  it.each(["@probex-platform/protocol", "vitest", "../connector/index.js", "./../connector/index.js", "util"])(
    "rejects %s",
    async (specifier) => {
      const messages = await findRestrictedImports("logger/level.ts", specifier);

      expect(messages).toHaveLength(1);
    },
  );

  it.each(["node:util", "./context.js"])("allows %s", async (specifier) => {
    const messages = await findRestrictedImports("logger/level.ts", specifier);

    expect(messages).toEqual([]);
  });
});

describe("debugger imports", { timeout: 60_000 }, () => {
  it.each([
    "ws",
    "vitest",
    "@probex-platform/sdk",
    "../connector/options/index.js",
    "../connector/hub-connector/hub-connector.js",
    "../logger/logger.js",
    "util",
  ])("rejects %s in a root file", async (specifier) => {
    const messages = await findRestrictedImports("debugger/debugger.ts", specifier);

    expect(messages).toHaveLength(1);
  });

  it.each([
    "@probex-platform/protocol",
    "../connector/index.js",
    "../logger/index.js",
    "node:inspector",
    "./inspector-session.js",
  ])("allows %s in a root file", async (specifier) => {
    const messages = await findRestrictedImports("debugger/debugger.ts", specifier);

    expect(messages).toEqual([]);
  });
});
