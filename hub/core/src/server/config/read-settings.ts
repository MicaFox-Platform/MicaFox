import {
  parseBoolean,
  parseChoice,
  parseDatabaseUrl,
  parseHost,
  parseInteger,
  parsePassword,
  parseProjectKey,
  parsePublicUrl,
  parseSecret,
  parseSourceUrl,
  parseTrustProxy,
} from "./parse-setting.js";
import type { SettingsReader } from "./settings-reader.js";

const MAX_PORT = 65_535;
const MAX_COUNT = 1_000_000_000;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const LOG_FORMATS = ["json", "pretty"] as const;

/** Every setting of `docs/api/hub/config.md`, checked and with its default. */
export interface Settings {
  /** Only missing in test mode, where the hub takes `http://localhost:<port>` once it is bound. */
  publicUrl: string | undefined;
  databaseUrl: string;
  migrationDatabaseUrl: string;
  databasePoolSize: number;
  host: string;
  port: number;
  trustProxy: boolean | number | string[];
  logLevel: (typeof LOG_LEVELS)[number];
  logFormat: (typeof LOG_FORMATS)[number];
  metricsPort: number | undefined;
  setupToken: string | undefined;
  sourceUrl: string | undefined;
  sdkMaxFrameBytes: number;
  sdkMaxConnections: number;
  sdkMaxConnectionsPerKey: number;
  sdkMaxMessagesPerSecond: number;
  writeQueueMaxBytes: number;
  retentionDays: Record<string, number>;
  debuggerSnapshotsPerSecond: number;
  debuggerMaxSnapshots: number;
  testMode: boolean;
  testProjectKey: string | undefined;
  testPassword: string | undefined;
}

// The URLs are missing when a problem was recorded for them
interface Database {
  databaseUrl: string | undefined;
  migrationDatabaseUrl: string | undefined;
  databasePoolSize: number;
}

const parseCount = (raw: string): ReturnType<typeof parseInteger> => parseInteger(raw, 1, MAX_COUNT);

const readDatabase = (reader: SettingsReader): Database => {
  const databaseUrl = reader.require("MICAFOX_DATABASE_URL", parseDatabaseUrl, { file: true });
  const migrationDatabaseUrl = reader.read("MICAFOX_MIGRATION_DATABASE_URL", parseDatabaseUrl, { file: true });
  const databasePoolSize = reader.read("MICAFOX_DATABASE_POOL_SIZE", (raw) => parseInteger(raw, 1, 1000)) ?? 10;
  // PGlite is the hub's own process's database, with one role: migrations reach it only through the hub's session
  const isPglite = [databaseUrl, migrationDatabaseUrl].some((url) => url?.startsWith("pglite:") === true);
  if (isPglite && migrationDatabaseUrl !== undefined && migrationDatabaseUrl !== databaseUrl) {
    reader.addProblem("MICAFOX_MIGRATION_DATABASE_URL: with a pglite: database, leave it unset or give the same URL");
  }
  return { databaseUrl, migrationDatabaseUrl: migrationDatabaseUrl ?? databaseUrl, databasePoolSize };
};

const readSdkLimits = (
  reader: SettingsReader,
): Pick<
  Settings,
  | "sdkMaxFrameBytes"
  | "sdkMaxConnections"
  | "sdkMaxConnectionsPerKey"
  | "sdkMaxMessagesPerSecond"
  | "writeQueueMaxBytes"
  | "debuggerSnapshotsPerSecond"
  | "debuggerMaxSnapshots"
> => ({
  sdkMaxFrameBytes: reader.read("MICAFOX_SDK_MAX_FRAME_BYTES", parseCount) ?? 1_048_576,
  sdkMaxConnections: reader.read("MICAFOX_SDK_MAX_CONNECTIONS", parseCount) ?? 1000,
  sdkMaxConnectionsPerKey: reader.read("MICAFOX_SDK_MAX_CONNECTIONS_PER_KEY", parseCount) ?? 500,
  sdkMaxMessagesPerSecond: reader.read("MICAFOX_SDK_MAX_MESSAGES_PER_SECOND", parseCount) ?? 1000,
  writeQueueMaxBytes: reader.read("MICAFOX_WRITE_QUEUE_MAX_BYTES", parseCount) ?? 10_485_760,
  debuggerSnapshotsPerSecond: reader.read("MICAFOX_DEBUGGER_SNAPSHOTS_PER_SECOND", parseCount) ?? 100,
  debuggerMaxSnapshots: reader.read("MICAFOX_DEBUGGER_MAX_SNAPSHOTS", parseCount) ?? 100_000,
});

const readServer = (
  reader: SettingsReader,
): Pick<
  Settings,
  | "host"
  | "port"
  | "trustProxy"
  | "logLevel"
  | "logFormat"
  | "metricsPort"
  | "setupToken"
  | "sourceUrl"
  | "retentionDays"
> => ({
  host: reader.read("MICAFOX_HOST", parseHost) ?? "0.0.0.0",
  port: reader.read("MICAFOX_PORT", (raw) => parseInteger(raw, 0, MAX_PORT)) ?? 8080,
  trustProxy: reader.read("MICAFOX_TRUST_PROXY", parseTrustProxy) ?? false,
  logLevel: reader.read("MICAFOX_LOG_LEVEL", (raw) => parseChoice(raw, LOG_LEVELS)) ?? "info",
  logFormat: reader.read("MICAFOX_LOG_FORMAT", (raw) => parseChoice(raw, LOG_FORMATS)) ?? "json",
  metricsPort: reader.read("MICAFOX_METRICS_PORT", (raw) => parseInteger(raw, 1, MAX_PORT)),
  setupToken: reader.read("MICAFOX_SETUP_TOKEN", parseSecret, { file: true }),
  sourceUrl: reader.read("MICAFOX_SOURCE_URL", parseSourceUrl),
  retentionDays: reader.readRetentionDays(),
});

const readTestMode = (
  reader: SettingsReader,
  databaseUrl: string | undefined,
): Pick<Settings, "testMode" | "testProjectKey" | "testPassword"> => {
  const testMode = reader.read("MICAFOX_TEST_MODE", parseBoolean) ?? false;
  if (testMode && databaseUrl !== undefined && !databaseUrl.startsWith("pglite:")) {
    reader.addProblem("MICAFOX_TEST_MODE: needs a pglite: MICAFOX_DATABASE_URL, never a real database");
  }
  return {
    testMode,
    testProjectKey: reader.read("MICAFOX_TEST_PROJECT_KEY", parseProjectKey, { file: true }),
    testPassword: reader.read("MICAFOX_TEST_PASSWORD", parsePassword, { file: true }),
  };
};

/** Reads every setting through `reader`; the result is only valid when `reader.problems()` is empty. */
export const readSettings = (reader: SettingsReader): Settings => {
  const database = readDatabase(reader);
  const testMode = readTestMode(reader, database.databaseUrl);
  // Test mode takes the URL from the port it binds, so only there may it be missing
  const publicUrl = testMode.testMode
    ? reader.read("MICAFOX_PUBLIC_URL", parsePublicUrl)
    : reader.require("MICAFOX_PUBLIC_URL", parsePublicUrl);
  return {
    publicUrl,
    // An empty URL stands in for a missing one only when problems were recorded, and then no settings are used
    databaseUrl: database.databaseUrl ?? "",
    migrationDatabaseUrl: database.migrationDatabaseUrl ?? "",
    databasePoolSize: database.databasePoolSize,
    ...readServer(reader),
    ...readSdkLimits(reader),
    ...testMode,
  };
};
