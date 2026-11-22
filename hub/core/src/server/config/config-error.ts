/** Thrown when settings are not valid; holds every problem, none of them with a value. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid settings: ${String(problems.length)} problem(s)`);
    this.name = "ConfigError";
  }

  /** The start-up report: every problem on its own line. */
  report(): string {
    return [
      "micafox-hub: the settings are not valid, nothing was started:",
      ...this.problems.map((p) => `  ${p}`),
    ].join("\n");
  }
}
