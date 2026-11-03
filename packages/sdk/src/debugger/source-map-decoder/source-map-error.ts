/** A source map that cannot be decoded; the message is a fixed reason and never carries map content. */
export class SourceMapError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SourceMapError";
  }
}
