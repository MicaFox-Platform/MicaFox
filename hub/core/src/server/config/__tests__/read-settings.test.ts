import { describe, expect, it } from "vitest";

import { envOf } from "../../../../test/server/env.js";
import { ConfigError, loadSettings, summarizeSettings } from "../index.js";
import type { Settings } from "../index.js";

const VALID = ["MICAFOX_PUBLIC_URL=https://hub.example.com", "MICAFOX_DATABASE_URL=postgres://app:s3cret@db:5432/hub"];

const load = (lines: readonly string[], files: Record<string, string> = {}): Settings => {
  return loadSettings({
    env: envOf(lines),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error("ENOENT");
      }
      return content;
    },
  });
};

const problemsOf = (lines: readonly string[], files: Record<string, string> = {}): readonly string[] => {
  try {
    load(lines, files);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.problems;
    }
    throw error;
  }
  return [];
};

describe("loadSettings", () => {
  it("applies the defaults of config.md", () => {
    const settings = load(VALID);

    expect(settings).toMatchObject({
      publicUrl: "https://hub.example.com",
      migrationDatabaseUrl: "postgres://app:s3cret@db:5432/hub",
      databasePoolSize: 10,
      host: "0.0.0.0",
      port: 8080,
      trustProxy: false,
      logLevel: "info",
      logFormat: "json",
      metricsPort: undefined,
      sdkMaxFrameBytes: 1_048_576,
      sdkMaxConnections: 1000,
      sdkMaxConnectionsPerKey: 500,
      sdkMaxMessagesPerSecond: 1000,
      writeQueueMaxBytes: 10_485_760,
      debuggerSnapshotsPerSecond: 100,
      debuggerMaxSnapshots: 100_000,
      testMode: false,
      retentionDays: {},
    });
  });

  it("reads every setting from the environment", () => {
    const settings = load([
      ...VALID,
      "MICAFOX_MIGRATION_DATABASE_URL=postgres://owner:pw@db:5432/hub",
      "MICAFOX_DATABASE_POOL_SIZE=20",
      "MICAFOX_HOST=127.0.0.1",
      "MICAFOX_PORT=0",
      "MICAFOX_TRUST_PROXY=1",
      "MICAFOX_LOG_LEVEL=debug",
      "MICAFOX_LOG_FORMAT=pretty",
      "MICAFOX_METRICS_PORT=9464",
      "MICAFOX_SETUP_TOKEN=setup-token",
      "MICAFOX_SOURCE_URL=https://git.example.com/hub",
      "MICAFOX_SDK_MAX_FRAME_BYTES=2097152",
      "MICAFOX_SDK_MAX_CONNECTIONS=50",
      "MICAFOX_SDK_MAX_CONNECTIONS_PER_KEY=20",
      "MICAFOX_SDK_MAX_MESSAGES_PER_SECOND=200",
      "MICAFOX_WRITE_QUEUE_MAX_BYTES=1048576",
      "MICAFOX_DEBUGGER_SNAPSHOTS_PER_SECOND=10",
      "MICAFOX_DEBUGGER_MAX_SNAPSHOTS=500",
      "MICAFOX_RETENTION_SNAPSHOTS_DAYS=7",
      "MICAFOX_RETENTION_ERRORS_DAYS=90",
    ]);

    expect(settings).toMatchObject({
      migrationDatabaseUrl: "postgres://owner:pw@db:5432/hub",
      databasePoolSize: 20,
      host: "127.0.0.1",
      port: 0,
      trustProxy: 1,
      logLevel: "debug",
      logFormat: "pretty",
      metricsPort: 9464,
      setupToken: "setup-token",
      sourceUrl: "https://git.example.com/hub",
      sdkMaxFrameBytes: 2_097_152,
      sdkMaxConnections: 50,
      sdkMaxConnectionsPerKey: 20,
      sdkMaxMessagesPerSecond: 200,
      writeQueueMaxBytes: 1_048_576,
      debuggerSnapshotsPerSecond: 10,
      debuggerMaxSnapshots: 500,
      retentionDays: { snapshots: 7, errors: 90 },
    });
  });

  it("reads secrets from *_FILE and drops the final newline", () => {
    const settings = load(
      [
        "MICAFOX_PUBLIC_URL=https://hub.example.com",
        "MICAFOX_DATABASE_URL_FILE=/run/secrets/db",
        "MICAFOX_SETUP_TOKEN_FILE=/run/secrets/token",
      ],
      { "/run/secrets/db": "postgres://app:pw@db/hub\n", "/run/secrets/token": "tok\r\n" },
    );

    expect(settings).toMatchObject({ databaseUrl: "postgres://app:pw@db/hub", setupToken: "tok" });
  });

  it("treats an empty variable as not set", () => {
    const settings = load([...VALID, "MICAFOX_PORT=", "MICAFOX_SETUP_TOKEN_FILE="]);

    expect(settings).toMatchObject({ port: 8080, setupToken: undefined });
  });

  it("reports every problem at once", () => {
    const problems = problemsOf([
      "MICAFOX_PUBLIC_URL=http://hub.example.com",
      "MICAFOX_PORT=70000",
      "MICAFOX_LOG_LEVEL=trace",
      "MICAFOX_TRUST_PROXY=maybe",
      "MICAFOX_RETENTION_SNAPSHOTS_DAYS=0",
    ]);

    expect(problems).toEqual([
      "MICAFOX_DATABASE_URL: required, or set MICAFOX_DATABASE_URL_FILE",
      expect.stringContaining("MICAFOX_PUBLIC_URL: must be https://"),
      "MICAFOX_PORT: must be an integer from 0 to 65535",
      "MICAFOX_TRUST_PROXY: must be true, false, a hop count, or a comma-separated list of IP addresses and CIDRs",
      "MICAFOX_LOG_LEVEL: must be one of debug, info, warn, error",
      "MICAFOX_RETENTION_SNAPSHOTS_DAYS: must be an integer from 1 to 36500",
    ]);
  });

  it("requires the public URL outside test mode", () => {
    expect(problemsOf(["MICAFOX_DATABASE_URL=postgres://db/hub"])).toEqual(["MICAFOX_PUBLIC_URL: required"]);
  });

  it("fails the start for HTTP on a host other than localhost", () => {
    expect(problemsOf([...VALID.slice(1), "MICAFOX_PUBLIC_URL=http://hub.example.com"])).toEqual([
      expect.stringContaining("MICAFOX_PUBLIC_URL"),
    ]);
  });

  it("says which file cannot be read and never a secret", () => {
    const problems = problemsOf([...VALID, "MICAFOX_SETUP_TOKEN_FILE=/run/secrets/missing"]);

    expect(problems).toEqual(["MICAFOX_SETUP_TOKEN_FILE: the file at /run/secrets/missing cannot be read"]);
  });

  it("rejects a setting given both directly and by file", () => {
    const problems = problemsOf([...VALID, "MICAFOX_SETUP_TOKEN=a", "MICAFOX_SETUP_TOKEN_FILE=/run/secrets/t"]);

    expect(problems).toEqual(["MICAFOX_SETUP_TOKEN: set it or MICAFOX_SETUP_TOKEN_FILE, not both"]);
  });

  it("never puts a rejected secret value into a problem", () => {
    const problems = problemsOf([
      "MICAFOX_PUBLIC_URL=https://hub.example.com",
      "MICAFOX_DATABASE_URL=mysql://app:hunter2@db/hub",
    ]);

    expect(problems.join("\n")).not.toContain("hunter2");
  });

  it("starts test mode on PGlite without a public URL", () => {
    const settings = load(["MICAFOX_TEST_MODE=true", "MICAFOX_DATABASE_URL=pglite:memory", "MICAFOX_PORT=0"]);

    expect(settings).toMatchObject({ testMode: true, publicUrl: undefined, port: 0 });
  });

  it("refuses test mode on a real database", () => {
    expect(problemsOf([...VALID, "MICAFOX_TEST_MODE=true"])).toEqual([
      "MICAFOX_TEST_MODE: needs a pglite: MICAFOX_DATABASE_URL, never a real database",
    ]);
  });

  it("refuses a Postgres migration URL for a PGlite database", () => {
    const problems = problemsOf([
      "MICAFOX_TEST_MODE=true",
      "MICAFOX_DATABASE_URL=pglite:memory",
      "MICAFOX_MIGRATION_DATABASE_URL=postgres://owner:pw@db:5432/hub",
    ]);

    expect(problems).toEqual([
      "MICAFOX_MIGRATION_DATABASE_URL: with a pglite: database, leave it unset or give the same URL",
    ]);
  });

  it("refuses another PGlite folder for the migrations than the database's", () => {
    const problems = problemsOf([
      "MICAFOX_TEST_MODE=true",
      "MICAFOX_DATABASE_URL=pglite:/data/hub",
      "MICAFOX_MIGRATION_DATABASE_URL=pglite:/data/other",
    ]);

    expect(problems).toEqual([
      "MICAFOX_MIGRATION_DATABASE_URL: with a pglite: database, leave it unset or give the same URL",
    ]);
  });

  it("accepts the database's own PGlite URL for the migrations", () => {
    const problems = problemsOf([
      "MICAFOX_TEST_MODE=true",
      "MICAFOX_DATABASE_URL=pglite:memory",
      "MICAFOX_MIGRATION_DATABASE_URL=pglite:memory",
    ]);

    expect(problems).toEqual([]);
  });

  it("refuses a PGlite migration URL for a Postgres database", () => {
    const problems = problemsOf([...VALID, "MICAFOX_MIGRATION_DATABASE_URL=pglite:memory"]);

    expect(problems).toEqual([
      "MICAFOX_MIGRATION_DATABASE_URL: with a pglite: database, leave it unset or give the same URL",
    ]);
  });

  it("checks the test project key and password", () => {
    const problems = problemsOf([
      "MICAFOX_TEST_MODE=true",
      "MICAFOX_DATABASE_URL=pglite:memory",
      "MICAFOX_TEST_PROJECT_KEY=mfx_pk_short",
      "MICAFOX_TEST_PASSWORD=short",
    ]);

    expect(problems).toEqual([
      "MICAFOX_TEST_PROJECT_KEY: must be mfx_pk_ followed by 43 characters",
      "MICAFOX_TEST_PASSWORD: must be 12 to 256 characters",
    ]);
  });
});

describe("summarizeSettings", () => {
  it("replaces every secret and strips credentials from database URLs", () => {
    const settings = load([
      ...VALID,
      "MICAFOX_SETUP_TOKEN=setup-token",
      "MICAFOX_MIGRATION_DATABASE_URL=postgres://owner:ownerpw@db:5432/hub?sslmode=require",
    ]);

    const summary = summarizeSettings(settings);

    expect(summary).toMatchObject({
      databaseUrl: "postgres://db:5432/hub",
      migrationDatabaseUrl: "postgres://db:5432/hub",
      setupToken: "[redacted]",
      publicUrl: "https://hub.example.com",
    });
    expect(JSON.stringify(summary)).not.toMatch(/s3cret|ownerpw|setup-token/);
  });
});

describe("ConfigError", () => {
  it("lists every problem in its report", () => {
    const error = new ConfigError(["MICAFOX_PORT: bad", "MICAFOX_LOG_LEVEL: bad"]);

    expect(error.report()).toBe(
      "micafox-hub: the settings are not valid, nothing was started:\n  MICAFOX_PORT: bad\n  MICAFOX_LOG_LEVEL: bad",
    );
  });
});
