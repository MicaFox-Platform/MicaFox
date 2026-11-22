import type { Settings } from "./read-settings.js";

const REDACTED = "[redacted]";

// Keeps the scheme, host and database of a URL, which an operator needs to see; user, password and query go
const withoutCredentials = (databaseUrl: string): string => {
  if (!databaseUrl.startsWith("postgres")) {
    return databaseUrl;
  }
  const url = new URL(databaseUrl);
  return `${url.protocol}//${url.host}${url.pathname}`;
};

const hide = (secret: string | undefined): string | undefined => (secret === undefined ? undefined : REDACTED);

/**
 * The settings as `hub.started` logs them. Each field is listed, so a setting added later stays out of the log until
 * it is added here; secrets show only that they are set, and database URLs lose their credentials.
 */
export const summarizeSettings = (settings: Settings): Record<string, unknown> => ({
  publicUrl: settings.publicUrl,
  databaseUrl: withoutCredentials(settings.databaseUrl),
  migrationDatabaseUrl: withoutCredentials(settings.migrationDatabaseUrl),
  databasePoolSize: settings.databasePoolSize,
  host: settings.host,
  port: settings.port,
  trustProxy: settings.trustProxy,
  logLevel: settings.logLevel,
  logFormat: settings.logFormat,
  metricsPort: settings.metricsPort,
  setupToken: hide(settings.setupToken),
  sourceUrl: settings.sourceUrl,
  sdkMaxFrameBytes: settings.sdkMaxFrameBytes,
  sdkMaxConnections: settings.sdkMaxConnections,
  sdkMaxConnectionsPerKey: settings.sdkMaxConnectionsPerKey,
  sdkMaxMessagesPerSecond: settings.sdkMaxMessagesPerSecond,
  writeQueueMaxBytes: settings.writeQueueMaxBytes,
  retentionDays: settings.retentionDays,
  debuggerSnapshotsPerSecond: settings.debuggerSnapshotsPerSecond,
  debuggerMaxSnapshots: settings.debuggerMaxSnapshots,
  testMode: settings.testMode,
  testProjectKey: hide(settings.testProjectKey),
  testPassword: hide(settings.testPassword),
});
