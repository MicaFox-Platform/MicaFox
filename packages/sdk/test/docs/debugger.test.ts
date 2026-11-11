import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOC = path.join(import.meta.dirname, "../../../../docs/api/sdk/debugger.md");
// The examples under Exports in order, each copied into a file that `pnpm typecheck` compiles
const COPIES = ["debugger-micafox.test-d.ts", "debugger-debugger.test-d.ts", "debugger-configure.test-d.ts"];

// The Usage example imports pino, which is not a dependency, so only what comes before it is compiled
const readExports = (markdown: string): string => markdown.slice(0, markdown.indexOf("\n## Usage"));

const readBlocks = (markdown: string): string[] =>
  Array.from(markdown.matchAll(/```ts\n([\s\S]*?)```/g), (match) => match[1] ?? "");

// A `ts` block that starts with an import is an example; one that declares the type or its options is a signature,
// pinned in index.test-d.ts
const isExample = (block: string): boolean => block.startsWith("import ");
const isSignature = (block: string): boolean => /^(const|interface) /.test(block);

// The copy without its header comment, which ends at the first blank line
const readCopy = (file: string): string => {
  const text = readFileSync(path.join(import.meta.dirname, file), "utf8");
  return text.slice(text.indexOf("\n\n") + 2);
};

describe("docs/api/sdk/debugger.md", () => {
  it("has the same examples under Exports as the copies the typecheck compiles", () => {
    const examples = readBlocks(readExports(readFileSync(DOC, "utf8"))).filter((block) => isExample(block));

    expect(COPIES.map((file) => readCopy(file))).toEqual(examples);
  });

  it("has no ts block under Exports that is neither an example nor a signature", () => {
    const blocks = readBlocks(readExports(readFileSync(DOC, "utf8")));

    expect(blocks.filter((block) => !isExample(block) && !isSignature(block))).toEqual([]);
  });
});
