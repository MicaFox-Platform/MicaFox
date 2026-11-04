// TypeScript fixtures compiled by tsc's own emitter when a test writes them, so the scripts and maps are real tsc
// output without committing generated files that formatting would change.

import { writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { Fixtures } from "./real-v8.js";

/**
 * A typed checkout module; its lines are what the tests set breakpoints on: 1 `interface`, 5 `total`, 6 `let sum`,
 * 7 `for`, 8 `sum += `, 9 `}`, 10 blank, 11 `return`. tsc drops the interface and adds a prologue, so the compiled
 * lines differ.
 */
export const TYPED_CHECKOUT_SOURCE = `export interface Item {
  readonly price: number;
}

export const total = (items: readonly Item[]): number => {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }

  return sum;
};
`;

/** Where a compiled fixture was written. */
export interface CompiledFixture {
  /** The compiled script, `dist/<name>-<tag>.js`. */
  script: string;
  /** Its map file, which exists only for a map in a file. */
  mapFile: string;
  /** The path a hub would send for the original, `src/<name>-<tag>.ts`. */
  file: string;
}

/** How the compiled script names its map: in a `.map` file beside it, or inline as a `data:` URL. */
export type MapPlacement = "file" | "inline";

/**
 * Compiles `source` as `<dir>/src/<name>.ts` into a CommonJS `<dir>/dist/<name>.js`, with a map whose `sourceRoot`
 * points back to `src/`, as `tsc --outDir dist --sourceRoot ../src/` does.
 */
export const writeCompiled = (
  fixtures: Fixtures,
  name: string,
  options: { source?: string; map?: MapPlacement; dir?: string } = {},
): CompiledFixture => {
  const dir = options.dir ?? "";
  const file = fixtures.file(path.posix.join(dir, "src", `${name}.ts`));
  const isInline = options.map === "inline";
  const { outputText, sourceMapText } = ts.transpileModule(options.source ?? TYPED_CHECKOUT_SOURCE, {
    fileName: path.posix.basename(file),
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      sourceRoot: "../src/",
      sourceMap: !isInline,
      inlineSourceMap: isInline,
    },
  });

  const script = fixtures.write(path.posix.join(dir, "dist", `${name}.js`), outputText);
  const mapFile = `${script}.map`;
  // Beside the script under the name tsc wrote into its comment, which carries the fixture's tag before `.js`
  if (sourceMapText !== undefined) {
    writeFileSync(mapFile, sourceMapText);
  }

  return { script, mapFile, file };
};
