import { createSourceMapText, encodeMappings, type Segment } from "./encode-mappings.js";

const createLines = (lineCount: number): Segment[][] => {
  let seed = 7;
  const next = (limit: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  };

  return Array.from({ length: lineCount }, () => {
    let column = 0;
    return Array.from({ length: 12 }, () => {
      column += 1 + next(12);
      return { column, source: next(3), line: next(60_000), originalColumn: next(80) };
    });
  });
};

const createText = (lineCount: number): string =>
  createSourceMapText(["a.ts", "b.ts", "c.ts"], encodeMappings(createLines(lineCount)));

/**
 * The text of a map with three sources, as long as possible without passing `maxLength`. Its original lines jump
 * about like those of a bundler's output, so sorting them is real work.
 */
export const createLargeSourceMapText = (maxLength: number): string => {
  const sampleLines = 1000;
  const charactersPerLine = createText(sampleLines).length / sampleLines;
  let text = createText(Math.floor((maxLength / charactersPerLine) * 0.99));
  while (text.length > maxLength) {
    text = createText(Math.floor((text.length / charactersPerLine) * 0.98));
  }

  return text;
};
