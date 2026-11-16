import { fileURLToPath } from "node:url";

/** An entry of a map's `sources` and the path it names. */
export interface MapSource {
  /** As written in `sources`, which the map's index is looked up by. */
  readonly source: string;
  /** The path with `/` separators: a local path for a `file:` source, the URL's path for any other scheme. */
  readonly path: string;
  /** `path` split at `/`, without empty and `.` segments. */
  readonly segments: readonly string[];
  /** Whether the path has a `node_modules` segment: such a source is never a candidate. */
  readonly isDependency: boolean;
}

const DEPENDENCIES = "node_modules";

// The spec joins sourceRoot and a source with one `/` between them, then resolves the result against the map's URL
const joinRoot = (sourceRoot: string, source: string): string => {
  if (sourceRoot === "") {
    return source;
  }

  return sourceRoot.endsWith("/") ? `${sourceRoot}${source}` : `${sourceRoot}/${source}`;
};

// Any other scheme, such as `webpack://app/./src/x.ts` or `turbopack:///[project]/src/x.ts`, keeps only its path
const toPath = (source: string, mapUrl: string): string | undefined => {
  try {
    const url = new URL(source, mapUrl);
    return url.protocol === "file:" ? fileURLToPath(url).replaceAll("\\", "/") : decodeURIComponent(url.pathname);
  } catch {
    // An unparsable URL, a file: URL with a host name or a broken `%` escape names no file the entry can match
    return undefined;
  }
};

const toMapSource = (source: string, path: string): MapSource => {
  // Split once here: every pending entry compares them again on each script that loads
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return { source, path, segments, isDependency: segments.includes(DEPENDENCIES) };
};

/**
 * Resolves the `sources` of a map against its `sourceRoot` and `mapUrl`, the URL of the map file or, for an inline
 * map, of its script. The result is aligned with `sources`, so a source is found by its id in O(1); a `null` entry,
 * which decoding turned into an empty string, and one that does not resolve are undefined. O(sources).
 */
export const resolveMapSources = (
  sourceRoot: string,
  sources: readonly string[],
  mapUrl: string,
): Array<MapSource | undefined> =>
  sources.map((source) => {
    const path = source === "" ? undefined : toPath(joinRoot(sourceRoot, source), mapUrl);
    return path === undefined ? undefined : toMapSource(source, path);
  });
