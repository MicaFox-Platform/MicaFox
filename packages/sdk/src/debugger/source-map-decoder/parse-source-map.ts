import { NO_SOURCE } from "./decode-mappings.js";
import type { WorkBudget } from "./sliced-work.js";
import { SourceMapError } from "./source-map-error.js";

/** The fields of a version 3 map that decoding needs, with an id for every entry of `sources`. */
export interface ParsedSourceMap {
  readonly sourceRoot: string;
  /** The entries of `sources`; a `null` entry becomes an empty string that no lookup by name finds. */
  readonly sources: readonly string[];
  /** For each entry of `sources`, the index of the first entry with its name, or `NO_SOURCE` for `null`. */
  readonly sourceIds: Int32Array;
  readonly sourceIdsByName: ReadonlyMap<string, number>;
  readonly mappings: string;
}

// JSON.parse cannot pause, and its cost grows with the number of values and the depth more than with the length.
// A map has a handful of fields, short lists and a few long strings: these bounds keep the parse of an 8 MiB map
// to a few milliseconds and reject what no map needs.
const MAX_DEPTH = 8;
const MAX_VALUES = 50_000;
const SCAN_CHUNK = 4096;

const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;

// Follows strings and nesting one character at a time, outside of JSON.parse
class JsonShapeScanner {
  private isInString = false;
  private isEscaped = false;
  private depth = 0;
  private values = 0;

  scan(code: number): void {
    if (this.isInString) {
      this.scanInString(code);
    } else if (code === QUOTE) {
      this.isInString = true;
    } else if (code === OPEN_BRACKET || code === OPEN_BRACE) {
      this.depth += 1;
      this.countValue();
      if (this.depth > MAX_DEPTH) {
        throw new SourceMapError("the source map is nested too deeply");
      }
    } else if (code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      this.depth -= 1;
    } else if (code === COMMA) {
      this.countValue();
    }
  }

  private scanInString(code: number): void {
    if (this.isEscaped) {
      this.isEscaped = false;
    } else if (code === BACKSLASH) {
      this.isEscaped = true;
    } else if (code === QUOTE) {
      this.isInString = false;
    }
  }

  private countValue(): void {
    this.values += 1;
    if (this.values > MAX_VALUES) {
      throw new SourceMapError("the source map has more than 50,000 JSON values");
    }
  }
}

const checkShape = function* (text: string, budget: WorkBudget): Generator<void, void, void> {
  const scanner = new JsonShapeScanner();
  for (let start = 0; start < text.length; start += SCAN_CHUNK) {
    const end = Math.min(start + SCAN_CHUNK, text.length);
    for (let index = start; index < end; index += 1) {
      scanner.scan(text.charCodeAt(index));
    }

    // A character costs far less to scan than to decode
    if (budget.spend((end - start) / 8)) {
      yield;
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceMapError("the source map is not valid JSON");
  }
};

// Sources with the same name share the id of the first, so a lookup by name finds every segment of the file.
// At most MAX_VALUES entries, so this needs no slicing.
const readSources = (value: unknown): Pick<ParsedSourceMap, "sources" | "sourceIds" | "sourceIdsByName"> => {
  if (!Array.isArray(value)) {
    throw new SourceMapError("sources must be a list of strings");
  }

  const entries: readonly unknown[] = value;
  const sources: string[] = [];
  const sourceIds = new Int32Array(entries.length);
  const sourceIdsByName = new Map<string, number>();
  for (const [index, name] of entries.entries()) {
    if (name !== null && typeof name !== "string") {
      throw new SourceMapError("sources must be a list of strings");
    }

    const firstIndex = name === null ? NO_SOURCE : (sourceIdsByName.get(name) ?? index);
    if (name !== null) {
      sourceIdsByName.set(name, firstIndex);
    }

    sources.push(name ?? "");
    sourceIds[index] = firstIndex;
  }

  return { sources, sourceIds, sourceIdsByName };
};

const readFields = (json: unknown): ParsedSourceMap => {
  if (!isRecord(json)) {
    throw new SourceMapError("the source map is not an object");
  }

  if ("sections" in json) {
    throw new SourceMapError("index maps are not supported");
  }

  if (json.version !== 3) {
    throw new SourceMapError("only source map version 3 is supported");
  }

  const { sourceRoot, mappings } = json;
  if (sourceRoot !== undefined && typeof sourceRoot !== "string") {
    throw new SourceMapError("sourceRoot must be a string");
  }

  if (typeof mappings !== "string") {
    throw new SourceMapError("mappings must be a string");
  }

  return { sourceRoot: sourceRoot ?? "", ...readSources(json.sources), mappings };
};

/**
 * Checks the shape of the text in slices, then parses it in one piece and reads the fields of a version 3 map.
 * O(characters).
 */
export const parseSourceMap = function* (text: string, budget: WorkBudget): Generator<void, ParsedSourceMap, void> {
  yield* checkShape(text, budget);
  return readFields(parseJson(text));
};
