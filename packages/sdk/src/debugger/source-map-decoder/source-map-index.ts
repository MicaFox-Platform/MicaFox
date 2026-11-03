import { LINE_RADIX, UNMAPPED, type Segments } from "./decode-mappings.js";

/** A position in the generated script. Lines and columns start at 0, as in V8. */
export interface GeneratedPosition {
  readonly line: number;
  readonly column: number;
}

/** A position in an original source. `source` is the entry of the map's `sources`, as written. */
export interface OriginalPosition {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

export interface SourceMapIndexParts {
  readonly sourceRoot: string;
  readonly sources: readonly string[];
  /** The id of the first source with each name, which the keys of `segments` use. */
  readonly sourceIdsByName: ReadonlyMap<string, number>;
  readonly segments: Segments;
  /** The indexes of the segments ordered by original key, see `sortByOriginal`. */
  readonly originalOrder: Int32Array;
}

// Reads an index the caller keeps in range; the fallback only satisfies `noUncheckedIndexedAccess`
const valueAt = (array: Int32Array | Float64Array, index: number): number => array[index] ?? 0;

const isPosition = (value: number): boolean => Number.isInteger(value) && value >= 0;

// The index of the last segment at or before (line, column) in generated order, or -1; O(log segments)
const findLastAtOrBefore = (segments: Segments, line: number, column: number): number => {
  let low = 0;
  let high = segments.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const middleLine = valueAt(segments.generatedLines, middle);
    if (middleLine < line || (middleLine === line && valueAt(segments.generatedColumns, middle) <= column)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low - 1;
};

// The first place in `originalOrder` whose key is at least `wanted`; O(log segments)
const findFirstKeyAtLeast = ({ segments, originalOrder }: SourceMapIndexParts, wanted: number): number => {
  let low = 0;
  let high = originalOrder.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (valueAt(segments.originalKeys, valueAt(originalOrder, middle)) < wanted) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

/** The indexes of one decoded source map: original line to generated position, and generated position to original. */
export class SourceMapIndex {
  readonly sourceRoot: string;
  readonly sources: readonly string[];

  constructor(private readonly parts: SourceMapIndexParts) {
    this.sourceRoot = parts.sourceRoot;
    this.sources = parts.sources;
  }

  /**
   * The first generated position of `line` in `source`, or of the next line that has one. Undefined when the source
   * is unknown or no line from `line` on has a position. O(log segments).
   */
  findGeneratedPosition(source: string, line: number): GeneratedPosition | undefined {
    const sourceId = this.parts.sourceIdsByName.get(source);
    if (sourceId === undefined || !isPosition(line) || line >= LINE_RADIX) {
      return undefined;
    }

    const { segments, originalOrder } = this.parts;
    const found = originalOrder[findFirstKeyAtLeast(this.parts, sourceId * LINE_RADIX + line)];
    if (found === undefined || valueAt(segments.originalKeys, found) >= (sourceId + 1) * LINE_RADIX) {
      return undefined;
    }

    return { line: valueAt(segments.generatedLines, found), column: valueAt(segments.generatedColumns, found) };
  }

  /**
   * The original position of the nearest segment on `line` at or before `column`. Undefined when the line has none
   * there, or when that segment maps to no source. O(log segments).
   */
  findOriginalPosition(line: number, column: number): OriginalPosition | undefined {
    if (!isPosition(line) || !isPosition(column)) {
      return undefined;
    }

    const { segments } = this.parts;
    const nearest = findLastAtOrBefore(segments, line, column);
    const key = nearest >= 0 ? valueAt(segments.originalKeys, nearest) : UNMAPPED;
    if (key === UNMAPPED || valueAt(segments.generatedLines, nearest) !== line) {
      return undefined;
    }

    const sourceId = Math.floor(key / LINE_RADIX);
    return {
      source: this.sources[sourceId] ?? "",
      line: key - sourceId * LINE_RADIX,
      column: valueAt(segments.originalColumns, nearest),
    };
  }
}
