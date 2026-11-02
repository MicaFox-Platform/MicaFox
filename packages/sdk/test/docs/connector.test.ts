import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOC = path.join(import.meta.dirname, "../../../../docs/api/sdk/connector.md");
// The doc's examples in order, each copied into a file that `pnpm typecheck` compiles
const COPIES = ["connector-hubconnector.test-d.ts", "connector-usage.test-d.ts"];

const readBlocks = (markdown: string): string[] =>
  Array.from(markdown.matchAll(/```ts\n([\s\S]*?)```/g), (match) => match[1] ?? "");

// A `ts` block that starts with an import is an example; one that declares the class or its options is a signature,
// pinned in index.test-d.ts
const isExample = (block: string): boolean => block.startsWith("import ");
const isSignature = (block: string): boolean => /^(class|interface) /.test(block);

// The copy without its header comment, which ends at the first blank line
const readCopy = (file: string): string => {
  const text = readFileSync(path.join(import.meta.dirname, file), "utf8");
  return text.slice(text.indexOf("\n\n") + 2);
};

describe("docs/api/sdk/connector.md", () => {
  it("has the same examples as the copies the typecheck compiles", () => {
    const examples = readBlocks(readFileSync(DOC, "utf8")).filter((block) => isExample(block));

    expect(COPIES.map((file) => readCopy(file))).toEqual(examples);
  });

  it("has no ts block that is neither an example nor a signature", () => {
    const blocks = readBlocks(readFileSync(DOC, "utf8"));

    expect(blocks.filter((block) => !isExample(block) && !isSignature(block))).toEqual([]);
  });
});
