import type { Parsed } from "./parse-setting.js";
import { parseInteger } from "./parse-setting.js";

const RETENTION = /^MICAFOX_RETENTION_([A-Z0-9_]+)_DAYS$/;
const MAX_RETENTION_DAYS = 36_500;

/** Reads settings from the environment and `*_FILE` files, collecting every problem instead of stopping at one. */
export interface SettingsReader {
  /** The value, or `undefined` when the setting is not set or not valid; a not valid one is recorded. */
  read: <T>(name: string, parse: (raw: string) => Parsed<T>, options?: { file?: boolean }) => T | undefined;
  /** Like `read`, but a setting that is not set is recorded as a problem too. */
  require: <T>(name: string, parse: (raw: string) => Parsed<T>, options?: { file?: boolean }) => T | undefined;
  /** Days by feature name for every `MICAFOX_RETENTION_<NAME>_DAYS`, the name in lower case. */
  readRetentionDays: () => Record<string, number>;
  /** Records a problem that no single setting owns. */
  addProblem: (problem: string) => void;
  problems: () => string[];
}

/** What the reader needs from the machine, passed in so tests need no files. */
export interface SettingsSource {
  env: Readonly<Record<string, string | undefined>>;
  readFile: (path: string) => string;
}

// Docker secrets and Kubernetes volumes usually end the file with a newline that is not part of the secret
const stripFinalNewline = (text: string): string => text.replace(/\r?\n$/, "");

type Resolved =
  { kind: "unset" } | { kind: "value"; label: string; raw: string } | { kind: "problem"; problem: string };

// An empty variable counts as not set: Compose and Helm pass empty strings for unset values
const valueOf = (source: SettingsSource, name: string): string | undefined => {
  const value = source.env[name];
  return value === "" ? undefined : value;
};

const resolveRaw = (source: SettingsSource, name: string, useFile: boolean): Resolved => {
  const direct = valueOf(source, name);
  const filePath = useFile ? valueOf(source, `${name}_FILE`) : undefined;
  if (direct !== undefined && filePath !== undefined) {
    return { kind: "problem", problem: `${name}: set it or ${name}_FILE, not both` };
  }
  if (filePath === undefined) {
    return direct === undefined ? { kind: "unset" } : { kind: "value", label: name, raw: direct };
  }
  try {
    return { kind: "value", label: `${name}_FILE`, raw: stripFinalNewline(source.readFile(filePath)) };
  } catch {
    return { kind: "problem", problem: `${name}_FILE: the file at ${filePath} cannot be read` };
  }
};

/** Creates a reader over `source`; its problems list grows as settings are read. */
export const createSettingsReader = (source: SettingsSource): SettingsReader => {
  const problems: string[] = [];
  const addProblem = (problem: string): void => {
    problems.push(problem);
  };

  const read: SettingsReader["read"] = (name, parse, options = {}) => {
    const found = resolveRaw(source, name, options.file === true);
    if (found.kind === "problem") {
      addProblem(found.problem);
      return undefined;
    }
    if (found.kind === "unset") {
      return undefined;
    }
    const parsed = parse(found.raw);
    if (parsed.ok) {
      return parsed.value;
    }
    addProblem(`${found.label}: ${parsed.problem}`);
    return undefined;
  };

  const requireSetting: SettingsReader["require"] = (name, parse, options = {}) => {
    const hasFile = options.file === true && valueOf(source, `${name}_FILE`) !== undefined;
    if (valueOf(source, name) === undefined && !hasFile) {
      addProblem(options.file === true ? `${name}: required, or set ${name}_FILE` : `${name}: required`);
      return undefined;
    }
    return read(name, parse, options);
  };

  const readRetentionDays = (): Record<string, number> => {
    const days: Record<string, number> = {};
    for (const name of Object.keys(source.env)) {
      const feature = RETENTION.exec(name)?.[1];
      const value = feature === undefined ? undefined : read(name, (raw) => parseInteger(raw, 1, MAX_RETENTION_DAYS));
      if (feature !== undefined && value !== undefined) {
        days[feature.toLowerCase()] = value;
      }
    }
    return days;
  };

  return { read, require: requireSetting, readRetentionDays, addProblem, problems: () => [...problems] };
};
