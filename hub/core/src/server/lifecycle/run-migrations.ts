import { createSystemClock } from "./hub.js";
import type { HubOptions } from "./hub.js";
import { runReadinessSteps } from "./readiness.js";
import type { ReadinessStep } from "./readiness.js";
import { EXIT_DEADLINE_MS } from "./run-hub.js";
import type { RunHubProcess } from "./run-hub.js";
import type { Clock } from "./shutdown.js";
import { openDatabase } from "./startup.js";
import { ConfigError, loadSettings, readSecretFile } from "../config/index.js";
import type { Settings } from "../config/index.js";
import type { Database } from "../db/index.js";
import { createFeatureRegistry, FeatureRegistryError } from "../feature/index.js";
import type { FeatureRegistry } from "../feature/index.js";
import { createLogger } from "../observability/index.js";
import type { HubLogger } from "../observability/index.js";

/** What `runMigrations` takes from the app; the environment and the log stream come from the process. */
export type RunMigrationsOptions = Pick<HubOptions, "features" | "extension" | "pgliteSeed" | "readFile" | "clock">;

// The settings and the checked features; a problem in either is printed whole, and nothing runs
const configOf = (
  options: RunMigrationsOptions,
  proc: RunHubProcess,
): { settings: Settings; registry: FeatureRegistry } | undefined => {
  try {
    return {
      settings: loadSettings({ env: proc.env, readFile: options.readFile ?? readSecretFile }),
      registry: createFeatureRegistry(options.features, options.extension),
    };
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof FeatureRegistryError)) {
      throw error;
    }
    proc.stderr.write(`${error.report()}\n`);
    return undefined;
  }
};

// The hub's own database steps: wait for the database as a start does, then migrate; true when both passed
const connectAndMigrate = async (
  parts: { db: Database; steps: readonly ReadinessStep[]; logger: HubLogger },
  signal: AbortSignal,
): Promise<boolean> => {
  const { db, steps, logger } = parts;
  try {
    await runReadinessSteps(steps, signal);
    logger.log.info("db.migrations-done");
    return true;
  } catch (error) {
    const message = signal.aborted ? "The migrations were stopped by a signal" : "The migrations failed";
    logger.log.error({ err: error }, message);
    return false;
  } finally {
    // Closing flushes a pglite:<folder> to disk; a database that never answered has nothing to close
    await db.close().catch((error: unknown) => {
      logger.log.warn({ err: error }, "The database did not close cleanly");
    });
  }
};

// The first signal aborts the wait or the migrations; the process ends with 1 on a second one, or when the abort
// does not end them within the deadline, as a migration statement only sees the signal once it returns
const exitOnSignals = (proc: RunHubProcess, clock: Clock, aborter: AbortController): (() => void) => {
  let deadline: ReturnType<Clock["setTimeout"]> | undefined;
  const onSignal = (): void => {
    if (aborter.signal.aborted) {
      proc.exit(1);
      return;
    }
    aborter.abort();
    deadline = clock.setTimeout(() => {
      proc.exit(1);
    }, EXIT_DEADLINE_MS);
    deadline.unref();
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
  return () => {
    if (deadline !== undefined) {
      clock.clearTimeout(deadline);
    }
  };
};

/**
 * Runs the missing migrations as `micafox-hub migrate` and exits: 0 once they are done, 1 when a setting is not
 * valid, a migration fails, or SIGTERM or SIGINT stops the wait for the database or the migrations; a second signal,
 * or 30 s after the first, exits with 1 at once.
 */
export const runMigrations = async (options: RunMigrationsOptions, proc: RunHubProcess): Promise<void> => {
  const config = configOf(options, proc);
  if (config === undefined) {
    proc.exit(1);
    return;
  }
  const { settings, registry } = config;
  const clock = options.clock ?? createSystemClock();
  const logger = createLogger({
    level: settings.logLevel,
    format: settings.logFormat,
    stream: proc.stdout,
    timers: clock,
  });
  const { db, steps } = openDatabase(settings, logger, { pgliteSeed: options.pgliteSeed, timers: clock, registry });
  const aborter = new AbortController();
  const clearDeadline = exitOnSignals(proc, clock, aborter);

  const isDone = await connectAndMigrate({ db, steps, logger }, aborter.signal);
  clearDeadline();
  logger.flush();
  proc.exit(isDone ? 0 : 1);
};
