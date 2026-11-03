import type { WorkBudget } from "./sliced-work.js";
import { SourceMapError } from "./source-map-error.js";

const COMMA = 44;
const SEMICOLON = 59;
const MAX_POSITION = 2 ** 31 - 1;
const COUNT_CHUNK = 4096;
// About 24 bytes a segment are kept and 44 while sorting: at most ~36 MB a map, ~66 MB at its peak. The 8 MiB
// fixture, with segments of 8 characters as a minified script has, holds 1,000,000.
const MAX_SEGMENTS = 1_500_000;

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const NOT_A_DIGIT = -1;
const CONTINUATION_BIT = 32;
const DIGIT_MASK = 31;
const BITS_PER_DIGIT = 5;
// Seven digits carry 35 bits, more than any position that is kept needs
const MAX_SHIFT = 30;

const DIGIT_VALUES: Int8Array = (() => {
  const values = new Int8Array(128).fill(NOT_A_DIGIT);
  for (let value = 0; value < BASE64_DIGITS.length; value += 1) {
    values[BASE64_DIGITS.charCodeAt(value)] = value;
  }

  return values;
})();

/** Original lines are stored as `sourceId * LINE_RADIX + line`, so one number orders by source, then by line. */
export const LINE_RADIX = 2 ** 31;

/** The key of a segment that maps to no original position. */
export const UNMAPPED = -1;

/** The id of a `null` entry of `sources`: its segments map to no original position. */
export const NO_SOURCE = -1;

/** The decoded segments in generated order, one entry per index of each array. */
export interface Segments {
  readonly count: number;
  readonly generatedLines: Int32Array;
  readonly generatedColumns: Int32Array;
  readonly originalKeys: Float64Array;
  readonly originalColumns: Int32Array;
}

/** Reads base64 VLQ values from a string, one after another; a bad character or a cut-off value is an error. */
export class VlqCursor {
  position = 0;

  constructor(private readonly text: string) {}

  /** The character code at the position, or -1 at the end. */
  peekCode(): number {
    return this.position < this.text.length ? this.text.charCodeAt(this.position) : -1;
  }

  /** Reads one signed value and moves past it. */
  read(): number {
    let magnitude = 0;
    let shift = 0;
    let digit: number;

    do {
      if (shift > MAX_SHIFT) {
        throw new SourceMapError("VLQ value is too large");
      }

      digit = this.readDigit();
      magnitude += (digit & DIGIT_MASK) * 2 ** shift;
      shift += BITS_PER_DIGIT;
    } while ((digit & CONTINUATION_BIT) !== 0);

    const value = Math.floor(magnitude / 2);
    // The lowest bit is the sign; a negative zero is a zero
    return magnitude % 2 === 1 && value !== 0 ? -value : value;
  }

  private readDigit(): number {
    const code = this.peekCode();
    const digit = code >= 0 && code < DIGIT_VALUES.length ? DIGIT_VALUES[code] : NOT_A_DIGIT;
    if (digit === undefined || digit === NOT_A_DIGIT) {
      throw new SourceMapError(code === -1 ? "mappings end inside a VLQ value" : "mappings hold a bad VLQ character");
    }

    this.position += 1;
    return digit;
  }
}

// Holds exactly the segments counted beforehand, so filling it never copies
class SegmentBuilder {
  private count = 0;
  private generatedLine = 0;
  private readonly generatedLines: Int32Array;
  private readonly generatedColumns: Int32Array;
  private readonly originalKeys: Float64Array;
  private readonly originalColumns: Int32Array;

  constructor(capacity: number) {
    this.generatedLines = new Int32Array(capacity);
    this.generatedColumns = new Int32Array(capacity);
    this.originalKeys = new Float64Array(capacity);
    this.originalColumns = new Int32Array(capacity);
  }

  startLine(): void {
    this.generatedLine += 1;
  }

  push(generatedColumn: number, originalKey: number, originalColumn: number): void {
    this.generatedLines[this.count] = this.generatedLine;
    this.generatedColumns[this.count] = generatedColumn;
    this.originalKeys[this.count] = originalKey;
    this.originalColumns[this.count] = originalColumn;
    this.count += 1;
  }

  build(): Segments {
    return {
      count: this.count,
      generatedLines: this.generatedLines,
      generatedColumns: this.generatedColumns,
      originalKeys: this.originalKeys,
      originalColumns: this.originalColumns,
    };
  }
}

// A segment is a run of characters between separators, so counting the runs gives the exact size to allocate
const countSegments = function* (mappings: string, budget: WorkBudget): Generator<void, number, void> {
  let count = 0;
  let isInSegment = false;

  for (let start = 0; start < mappings.length; start += COUNT_CHUNK) {
    const end = Math.min(start + COUNT_CHUNK, mappings.length);
    for (let index = start; index < end; index += 1) {
      const code = mappings.charCodeAt(index);
      const isSeparator = code === COMMA || code === SEMICOLON;
      count += isInSegment || isSeparator ? 0 : 1;
      isInSegment = !isSeparator;
    }

    // A character costs far less to count than to decode
    if (budget.spend((end - start) / 8)) {
      yield;
    }
  }

  if (count > MAX_SEGMENTS) {
    throw new SourceMapError("the source map has more than 1,500,000 segments");
  }

  return count;
};

const checkPosition = (value: number): number => {
  if (value < 0 || value > MAX_POSITION) {
    throw new SourceMapError("a mapping position is out of range");
  }

  return value;
};

// The running values of a mappings string: each field is a delta from the same field of the previous segment, and
// only the generated column starts again at every line
class SegmentReader {
  private generatedColumn = 0;
  private sourceIndex = 0;
  private originalLine = 0;
  private originalColumn = 0;

  constructor(
    private readonly cursor: VlqCursor,
    private readonly sourceIds: Int32Array,
  ) {}

  startLine(): void {
    this.generatedColumn = 0;
  }

  readInto(builder: SegmentBuilder): void {
    const column = checkPosition(this.generatedColumn + this.cursor.read());
    // Lookups search each line by column, so a line that goes backwards cannot be searched
    if (column < this.generatedColumn) {
      throw new SourceMapError("mappings are not in generated order");
    }

    this.generatedColumn = column;
    if (this.isAtSegmentEnd()) {
      builder.push(column, UNMAPPED, 0);
      return;
    }

    this.readOriginal();
    const sourceId = this.sourceIds[this.sourceIndex];
    if (sourceId === undefined) {
      throw new SourceMapError("a source index is out of range");
    }

    const key = sourceId === NO_SOURCE ? UNMAPPED : sourceId * LINE_RADIX + this.originalLine;
    builder.push(column, key, this.originalColumn);
    // A name index follows in some segments; no lookup needs it
    if (!this.isAtSegmentEnd()) {
      this.cursor.read();
    }

    if (!this.isAtSegmentEnd()) {
      throw new SourceMapError("a segment has too many fields");
    }
  }

  private readOriginal(): void {
    this.sourceIndex += this.cursor.read();
    this.originalLine = checkPosition(this.originalLine + this.readNextField());
    this.originalColumn = checkPosition(this.originalColumn + this.readNextField());
  }

  // A segment has one, four or five fields: after the first, the source, line and column come together
  private readNextField(): number {
    if (this.isAtSegmentEnd()) {
      throw new SourceMapError("a segment has two or three fields");
    }

    return this.cursor.read();
  }

  private isAtSegmentEnd(): boolean {
    const code = this.cursor.peekCode();
    return code === -1 || code === COMMA || code === SEMICOLON;
  }
}

/**
 * Decodes a `mappings` string into segments, yielding whenever the budget says a slice is spent. `sourceIds` turns
 * a source index of the map into the id that every source with the same name shares, or `NO_SOURCE`.
 * O(characters).
 */
export const decodeMappings = function* (
  mappings: string,
  sourceIds: Int32Array,
  budget: WorkBudget,
): Generator<void, Segments, void> {
  const cursor = new VlqCursor(mappings);
  const reader = new SegmentReader(cursor, sourceIds);
  const builder = new SegmentBuilder(yield* countSegments(mappings, budget));

  while (cursor.peekCode() !== -1) {
    const start = cursor.position;
    const code = cursor.peekCode();
    if (code === SEMICOLON) {
      reader.startLine();
      builder.startLine();
      cursor.position += 1;
    } else if (code === COMMA) {
      cursor.position += 1;
    } else {
      reader.readInto(builder);
    }

    if (budget.spend(cursor.position - start)) {
      yield;
    }
  }

  return builder.build();
};
