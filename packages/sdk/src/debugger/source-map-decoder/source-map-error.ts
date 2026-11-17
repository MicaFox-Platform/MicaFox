/**
 * A source map that cannot be decoded; the message is a fixed reason and never carries map content. `isOverLimit`
 * marks a map that is valid as far as was read but larger than the debugger reads.
 */
export class SourceMapError extends Error {
  constructor(
    reason: string,
    readonly isOverLimit = false,
  ) {
    super(reason);
    this.name = "SourceMapError";
  }
}
