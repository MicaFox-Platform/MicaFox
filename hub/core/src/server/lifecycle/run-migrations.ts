import { createSystemClock, openDatabase } from "./hub.js";
import type { HubOptions } from "./hub.js";
import { runReadinessSteps } from "./readiness.js";
import type { ReadinessStep } from "./readiness.js";
import { EXIT_DEADLINE_MS } from "./run-hub.js";
import type { RunHubProcess } from "./run-hub.js";
import type { Clock } from "./shutdown.js";
import { ConfigError, loadSettings, readSecretFile } from "../config/index.js";
import type { Settings } from "../config/index.js";
import type { Database } from "../db/index.js";
import { createLogger } from "../observability/index.js";
import type { HubLogger } from "../observability/index.js";

/** What `runMigrations` takes from the app; the environment and the log stream come from the process. */
export type RunMigrationsOptions = Pick<HubOptions, "pgliteSeed" | "readFile" | "clock">;

const settingsOf = (options: RunMigrationsOptions, proc: RunHubProcess): Settings | undefined => {
  try {
    return loadSettings({ env: proc.env, readFile: options.readFile ?? readSecretFile });
  } catch (error) {
    if (!(error instanceof ConfigError)) {
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
  const settings = settingsOf(options, proc);
  if (settings === undefined) {
    proc.exit(1);
    return;
  }
  const clock = options.clock ?? createSystemClock();
  const logger = createLogger({
    level: settings.logLevel,
    format: settings.logFormat,
    stream: proc.stdout,
    timers: clock,
  });
  const { db, steps } = openDatabase(settings, logger, { pgliteSeed: options.pgliteSeed, timers: clock });
  const aborter = new AbortController();
  const clearDeadline = exitOnSignals(proc, clock, aborter);

  const isDone = await connectAndMigrate({ db, steps, logger }, aborter.signal);
  clearDeadline();
  logger.flush();
  proc.exit(isDone ? 0 : 1);
};
