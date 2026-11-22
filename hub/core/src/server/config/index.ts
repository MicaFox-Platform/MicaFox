import { ConfigError } from "./config-error.js";
import { readSettings } from "./read-settings.js";
import type { Settings } from "./read-settings.js";
import { createSettingsReader } from "./settings-reader.js";
import type { SettingsSource } from "./settings-reader.js";

export { ConfigError } from "./config-error.js";
export type { Settings } from "./read-settings.js";
export type { SettingsSource } from "./settings-reader.js";
export { readSecretFile } from "./read-secret-file.js";
export { summarizeSettings } from "./summarize-settings.js";

/** Reads and checks every setting of the hub; throws a `ConfigError` with all problems when any is not valid. */
export const loadSettings = (source: SettingsSource): Settings => {
  const reader = createSettingsReader(source);
  const settings = readSettings(reader);
  const problems = reader.problems();
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return settings;
};
