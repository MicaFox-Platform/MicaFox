import type { StackFrame } from "@probex-platform/protocol";
import { fileURLToPath } from "node:url";

import type { MapView } from "./source-maps.js";

/** Where a stack frame is shown: a path or URL, and a 1-based line and column. */
export type FrameLocation = Pick<StackFrame, "file" | "line" | "column">;

// What V8 prints for the frame of an eval or `new Function`, which have no URL
const ANONYMOUS = "<anonymous>";

// A `file:` URL becomes a local path with `/` separators, as the paths of the map's sources are; any other URL,
// such as `node:internal/modules/cjs/loader`, is shown as it is
const toScriptPath = (url: string | undefined): string => {
  if (url === undefined || url === "") {
    return ANONYMOUS;
  }

  if (!url.startsWith("file:")) {
    return url;
  }

  try {
    return fileURLToPath(url).replaceAll("\\", "/");
  } catch {
    // A file: URL with a host name names no local path
    return url;
  }
};

// O(sources) for the source's path; a script that is not a bundle has one, and a frame is looked up at most 20 times
const findOriginal = (view: Extract<MapView, { kind: "read" }>, line: number, column: number) => {
  const position = view.index?.findOriginalPosition(line, column);
  const source = view.sources.find((candidate) => candidate.source === position?.source);
  if (position === undefined || source === undefined) {
    return undefined;
  }

  return { file: source.path, line: position.line + 1, column: position.column + 1 };
};

/** A position in a script: 0-based line and column, as V8 reports them. */
export interface FramePosition {
  readonly line: number;
  readonly column: number;
}

/**
 * Where the frame at `position` of the script `url` is shown: the original source position where `view` holds the
 * script's decoded map and maps the position, else the script's own path and position.
 */
export const locateFrame = (url: string | undefined, view: MapView, position: FramePosition): FrameLocation => {
  const original = view.kind === "read" ? findOriginal(view, position.line, position.column) : undefined;
  return original ?? { file: toScriptPath(url), line: position.line + 1, column: position.column + 1 };
};
