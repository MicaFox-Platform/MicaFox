const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A mapped segment with absolute positions; `source` is an index of the map's `sources`. */
export interface MappedSegment {
  readonly column: number;
  readonly source: number;
  readonly line: number;
  readonly originalColumn: number;
}

/** A segment that maps to no source: only its generated column. */
export type Segment = MappedSegment | { readonly column: number };

/** Encodes one signed value as base64 VLQ, the reference the decoder is tested against. */
export const encodeVlq = (value: number): string => {
  let remaining = value < 0 ? -value * 2 + 1 : value * 2;
  let encoded = "";

  do {
    const digit = remaining % 32;
    remaining = Math.floor(remaining / 32);
    encoded += BASE64_DIGITS.charAt(remaining > 0 ? digit + 32 : digit);
  } while (remaining > 0);

  return encoded;
};

const isMapped = (segment: Segment): segment is MappedSegment => "source" in segment;

/** Builds a `mappings` string from lines of segments with absolute positions, which it turns into deltas. */
export const encodeMappings = (lines: ReadonlyArray<readonly Segment[]>): string => {
  let source = 0;
  let line = 0;
  let originalColumn = 0;

  return lines
    .map((segments) => {
      let column = 0;
      return segments
        .map((segment) => {
          const fields = [segment.column - column];
          column = segment.column;
          if (isMapped(segment)) {
            fields.push(segment.source - source, segment.line - line, segment.originalColumn - originalColumn);
            ({ source, line, originalColumn } = {
              source: segment.source,
              line: segment.line,
              originalColumn: segment.originalColumn,
            });
          }

          return fields.map((field) => encodeVlq(field)).join("");
        })
        .join(",");
    })
    .join(";");
};

/** The text of a version 3 map with the given sources and mappings. */
export const createSourceMapText = (sources: readonly string[], mappings: string, sourceRoot?: string): string =>
  JSON.stringify({ version: 3, ...(sourceRoot === undefined ? {} : { sourceRoot }), sources, names: [], mappings });
