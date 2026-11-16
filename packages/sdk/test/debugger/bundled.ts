// Bundles written the way esbuild writes CommonJS output: the modules one after another in one script, a comment
// before each, and one source map that lists every module. Each line of a module maps to its own original line, so
// a test sets breakpoints by the original line numbers.

import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { Fixtures } from "./real-v8.js";
import { createSourceMapText, encodeMappings, type Segment } from "../source-maps/encode-mappings.js";

/** A module of a bundle: the path its map names, relative to the bundle's folder, and its code. */
export interface BundledModule {
  source: string;
  code: string;
}

/** A cart module; line 2 `return items.length`. */
export const CART_MODULE = `function count(items) {
  return items.length;
}
`;

/** A checkout module with the lines of `CHECKOUT_SOURCE`: 4 `sum += `, 6 `return`. */
export const CHECKOUT_MODULE = `function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}
`;

/** Where a bundle was written. */
export interface BundleFixture {
  script: string;
  /** Its map file, which exists only for a map in a file. */
  mapFile: string;
}

const codeLines = (code: string): string[] => code.replace(/\n$/, "").split("\n");

/**
 * Writes `modules` as one CommonJS script `<relative>` that exports `total` and `count` when the modules define
 * them, with a source map inline or in a `.map` file beside it; `mapText` replaces the map the modules give.
 */
export const writeBundle = (
  fixtures: Fixtures,
  relative: string,
  options: { modules: readonly BundledModule[]; map?: "file" | "inline"; mapText?: string },
): BundleFixture => {
  const lines: string[] = ['"use strict";'];
  const mappings: Segment[][] = [[]];
  for (const [sourceIndex, module] of options.modules.entries()) {
    lines.push(`// ${module.source}`);
    mappings.push([]);
    for (const [line, text] of codeLines(module.code).entries()) {
      lines.push(text);
      mappings.push([{ column: 0, source: sourceIndex, line, originalColumn: 0 }]);
    }
  }

  lines.push(
    'if (typeof total === "function") exports.total = total;',
    'if (typeof count === "function") exports.count = count;',
  );
  const sources = options.modules.map((module) => module.source);
  const mapText = options.mapText ?? createSourceMapText(sources, encodeMappings(mappings));
  const isInline = options.map === "inline";
  const mapUrl = isInline
    ? `data:application/json;base64,${Buffer.from(mapText).toString("base64")}`
    : `${path.posix.basename(fixtures.file(relative))}.map`;
  const script = fixtures.write(relative, `${lines.join("\n")}\n//# sourceMappingURL=${mapUrl}\n`);
  const mapFile = `${script}.map`;
  if (!isInline) {
    writeFileSync(mapFile, mapText);
  }

  return { script, mapFile };
};
