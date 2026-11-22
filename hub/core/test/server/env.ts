// Environment lines read like a .env file, so the setting names stay as operators write them
export const envOf = (lines: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    lines.map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );

// Test mode with a free port: the hub takes its URL from the port it binds, and no database is reached
export const TEST_MODE_LINES = [
  "MICAFOX_TEST_MODE=true",
  "MICAFOX_DATABASE_URL=pglite:memory",
  "MICAFOX_HOST=127.0.0.1",
  "MICAFOX_PORT=0",
];
