import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../connector/index.js";

/** A loaded script the breakpoints can be set in. */
export interface ScriptRecord {
  /** As V8 reported it, so that `Debugger.setBreakpointByUrl` finds this script and every later one with it. */
  url: string;
  /** The path of the script, split into segments. */
  segments: string[];
  /** The script's `sourceMappingURL`, as written; absent when it names none. */
  sourceMapUrl?: string;
}

/** A recorded script that names a source map. */
export interface MappedRecord extends ScriptRecord {
  sourceMapUrl: string;
}

/** Splits a path into its segments, with `/` as the separator; `\` counts as one, so Windows paths compare equal. */
export const toSegments = (path: string): string[] =>
  path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

/** A file name without its last extension, which a script and the original file it was compiled from share. */
export const toBaseName = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
};

const isMapped = (script: ScriptRecord): script is MappedRecord => script.sourceMapUrl !== undefined;

// A file: URL or an absolute path is a file of the app; eval, new Function and node: internals have neither
const toPath = (url: string): string | undefined => {
  if (url.startsWith("file:")) {
    try {
      return fileURLToPath(url);
    } catch {
      // Not a local file URL, such as one with a host name
      return undefined;
    }
  }

  return isAbsolute(url) ? url : undefined;
};

/**
 * The scripts V8 reported with `Debugger.scriptParsed`, one record per URL, found by file name and, for scripts
 * with a source map, by base name. It grows with the files the app loads while breakpoints are set, and is dropped
 * with the last of them.
 */
export class ScriptRegistry {
  private readonly byFileName = new Map<string, Map<string, ScriptRecord>>();
  private readonly mappedByBaseName = new Map<string, Map<string, MappedRecord>>();

  /** Records the script of a `Debugger.scriptParsed` event, replacing the record of its URL; ignores others. */
  record(params: unknown): ScriptRecord | undefined {
    const url: unknown = isRecord(params) ? Reflect.get(params, "url") : undefined;
    if (!isRecord(params) || typeof url !== "string") {
      return undefined;
    }

    const path = toPath(url);
    const segments = path === undefined ? [] : toSegments(path);
    const fileName = segments.at(-1);
    if (fileName === undefined) {
      return undefined;
    }

    const sourceMapUrl: unknown = Reflect.get(params, "sourceMapURL");
    const script: ScriptRecord =
      typeof sourceMapUrl === "string" && sourceMapUrl !== "" ? { url, segments, sourceMapUrl } : { url, segments };
    const sameName = this.byFileName.get(fileName) ?? new Map<string, ScriptRecord>();
    sameName.set(url, script);
    this.byFileName.set(fileName, sameName);
    this.indexByBaseName(fileName, script);
    return script;
  }

  /** The scripts without a source map whose path ends in `fileName`. */
  findCandidates(fileName: string): ScriptRecord[] {
    return [...(this.byFileName.get(fileName)?.values() ?? [])].filter((script) => !isMapped(script));
  }

  /** The scripts with a source map whose file name without its extension is `baseName`. */
  findMapped(baseName: string): MappedRecord[] {
    return [...(this.mappedByBaseName.get(baseName)?.values() ?? [])];
  }

  clear(): void {
    this.byFileName.clear();
    this.mappedByBaseName.clear();
  }

  // A script with the URL of a recorded one replaces it, also when one of them has a map and the other has not
  private indexByBaseName(fileName: string, script: ScriptRecord): void {
    const baseName = toBaseName(fileName);
    const sameBaseName = this.mappedByBaseName.get(baseName) ?? new Map<string, MappedRecord>();
    sameBaseName.delete(script.url);
    if (isMapped(script)) {
      sameBaseName.set(script.url, script);
    }

    if (sameBaseName.size === 0) {
      this.mappedByBaseName.delete(baseName);
    } else {
      this.mappedByBaseName.set(baseName, sameBaseName);
    }
  }
}
