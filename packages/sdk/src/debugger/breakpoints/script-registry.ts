import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../connector/index.js";

/** A loaded script the breakpoints can be set in. */
export interface ScriptRecord {
  /** As V8 reported it, so that `Debugger.setBreakpointByUrl` finds this script and every later one with it. */
  url: string;
  /** The path of the script, split into segments. */
  segments: string[];
  hasSourceMap: boolean;
}

/** Splits a path into its segments, with `/` as the separator; `\` counts as one, so Windows paths compare equal. */
export const toSegments = (path: string): string[] =>
  path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

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
 * The scripts V8 reported with `Debugger.scriptParsed`, one record per URL, found by file name. It grows with the
 * files the app loads while breakpoints are set, and is dropped with the last of them.
 */
export class ScriptRegistry {
  private readonly byFileName = new Map<string, Map<string, ScriptRecord>>();

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
    const hasSourceMap = typeof sourceMapUrl === "string" && sourceMapUrl !== "";
    const script: ScriptRecord = { url, segments, hasSourceMap };
    const sameName = this.byFileName.get(fileName) ?? new Map<string, ScriptRecord>();
    sameName.set(url, script);
    this.byFileName.set(fileName, sameName);
    return script;
  }

  /** The scripts without a source map whose path ends in `fileName`. */
  findCandidates(fileName: string): ScriptRecord[] {
    return [...(this.byFileName.get(fileName)?.values() ?? [])].filter((script) => !script.hasSourceMap);
  }

  clear(): void {
    this.byFileName.clear();
  }
}
