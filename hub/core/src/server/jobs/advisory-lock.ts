import pg from "pg";
import type { Logger } from "pino";

/** A job's lock while its run lasts. */
export interface HeldLock {
  /** Aborts when the lock's connection is lost, which would let another replica run the job too. */
  lost: AbortSignal;
  release: () => Promise<void>;
}

/** Takes the lock of a job for one run; `undefined` when another replica holds it. */
export interface JobLocks {
  tryLock: (job: string) => Promise<HeldLock | undefined>;
}

const CONNECT_TIMEOUT_MS = 5000;
const KEEPALIVE_IDLE_MS = 30_000;
const SERVER_KEEPALIVES = "-c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3";
// Each job has its own key; the migrator's is `micafox.migrations`
const TRY_LOCK = "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked";

/**
 * Locks on Postgres. A session lock lives and dies with its connection, so a replica that crashes or is lost never
 * keeps it for long; the connection is the lock's alone, since a pooled one would hand the lock to whoever borrows it
 * next.
 */
export const createPostgresLocks = (url: string, log: Logger): JobLocks => ({
  tryLock: async (job) => {
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // The connection is silent while the run lasts: keepalives on both ends find a lost peer within a minute or
      // so, which aborts the run here and frees the lock on the server for the other replicas
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_IDLE_MS,
      options: SERVER_KEEPALIVES,
    });
    const lost = new AbortController();
    // Unheard, an error on a client nobody is querying would crash the hub
    client.on("error", (error) => {
      log.warn({ job, err: error }, "A job's lock connection failed");
      lost.abort(new Error("The job's lock was lost with its connection", { cause: error }));
    });
    try {
      await client.connect();
      const { rows } = await client.query<{ locked: boolean }>(TRY_LOCK, [`micafox.job.${job}`]);
      if (rows[0]?.locked !== true) {
        await client.end();
        return undefined;
      }
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
  },
});

/** PGlite runs inside one hub with one session and no other client: there is nothing to lock against. */
export const PGLITE_LOCKS: JobLocks = {
  tryLock: async () =>
    await Promise.resolve({
      lost: new AbortController().signal,
      release: async () => {
        await Promise.resolve();
      },
    }),
};
