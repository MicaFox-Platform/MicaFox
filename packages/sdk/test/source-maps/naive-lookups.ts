import type { Segment, MappedSegment } from "./encode-mappings.js";
import type { GeneratedPosition, OriginalPosition } from "../../src/debugger/source-map-decoder/index.js";

/** The first generated position of `line` or of the next line that has one, by scanning every segment. */
export const naiveGeneratedPosition = (
  lines: ReadonlyArray<readonly Segment[]>,
  source: number,
  line: number,
): GeneratedPosition | undefined => {
  const candidates = lines.flatMap((segments, generatedLine) =>
    segments
      .filter((segment): segment is MappedSegment => "source" in segment && segment.source === source)
      .filter((segment) => segment.line >= line)
      .map((segment) => ({ generatedLine, ...segment })),
  );
  const nextLine = Math.min(...candidates.map((candidate) => candidate.line));
  const first = candidates.find((candidate) => candidate.line === nextLine);

  return first === undefined ? undefined : { line: first.generatedLine, column: first.column };
};

/** The original position of the last segment of the line at or before the column, by scanning the line. */
export const naiveOriginalPosition = (
  lines: ReadonlyArray<readonly Segment[]>,
  sources: readonly string[],
  position: GeneratedPosition,
): OriginalPosition | undefined => {
  const before = (lines[position.line] ?? []).filter((segment) => segment.column <= position.column);
  const nearest = before.at(-1);

  return nearest !== undefined && "source" in nearest
    ? { source: sources[nearest.source] ?? "", line: nearest.line, column: nearest.originalColumn }
    : undefined;
};
