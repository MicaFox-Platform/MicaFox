import { Kysely, PostgresDialect } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { Logger } from "pino";

/** Where migrations run, with the lock held until `close`. */
export interface MigrationTarget {
  db: Kysely<unknown>;
  /** Aborts when the hub stops or the lock's connection is lost, which would let another hub migrate too. */
  signal: AbortSignal;
  close: () => Promise<void>;
}

interface TargetOptions {
  /** The migration role's URL: `MICAFOX_MIGRATION_DATABASE_URL`, or the app's when it is not set. */
  url: string;
  /**
   * PGlite has one session and no other client, so there is nothing to lock against and its migrations run through
   * the handle the hub already has.
   */
  session: Kysely<unknown> | undefined;
  log: Logger;
}

const CONNECT_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 500;
// Only this key is used for migrations; jobs take their own keys
const TRY_LOCK = "select pg_try_advisory_lock(hashtextextended('micafox.migrations', 0)) as locked";

// Polls instead of a blocking pg_advisory_lock: a backend blocked on a lock reads nothing, not even a terminate, so a
// stop could never end the wait. `delay` rejects as soon as the hub stops.
const waitForLock = async (client: pg.Client, log: Logger, signal: AbortSignal): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    const { rows } = await client.query<{ locked: boolean }>(TRY_LOCK);
    if (rows[0]?.locked === true) {
      return;
    }
    if (attempt === 0) {
      log.info("Another hub is migrating the database; waiting for it");
    }
    await delay(LOCK_POLL_MS, undefined, { signal });
  }
};

// A session lock lives and dies with its connection, so a crashed replica never leaves it held. The client is the
// lock's alone: a pooled connection would hand the lock to whoever borrows it next.
const lockOnOwnClient = async (
  url: string,
  log: Logger,
  signal: AbortSignal,
): Promise<{ lost: AbortSignal; release: () => Promise<void> }> => {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  const lost = new AbortController();
  // Unheard, an error on a client nobody is querying would crash the hub
  client.on("error", (error) => {
    log.warn({ err: error }, "The migration lock connection failed");
    lost.abort(new Error("The migration lock was lost with its connection", { cause: error }));
  });
  try {
    await client.connect();
    await waitForLock(client, log, signal);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    lost: lost.signal,
    release: async () => {
      await client.end();
    },
  };
};

const openPostgres = async (options: TargetOptions, signal: AbortSignal): Promise<MigrationTarget> => {
  const pool = new pg.Pool({ connectionString: options.url, max: 1, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  const onError = (error: Error): void => {
    options.log.warn({ err: error }, "The migration connection failed");
  };
  // The pool reports only idle connections; one a migration holds between queries reports to itself
  pool.on("error", onError);
  pool.on("connect", (client) => {
    client.on("error", onError);
  });
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  try {
    const lock = await lockOnOwnClient(options.url, options.log, signal);
    return {
      db,
      signal: AbortSignal.any([signal, lock.lost]),
      close: async () => {
        try {
          await db.destroy();
        } finally {
          await lock.release();
        }
      },
    };
  } catch (error) {
    await db.destroy();
    throw error;
  }
};

/** Takes the migration lock, waiting while another hub migrates, and returns the connection to migrate through. */
export const openTarget = async (options: TargetOptions, signal: AbortSignal): Promise<MigrationTarget> => {
  if (options.session !== undefined) {
    return { db: options.session, signal, close: () => Promise.resolve() };
  }
  return await openPostgres(options, signal);
};
