import type { ScheduledJob } from "./scheduler.js";
import { deleteExpiredSessions } from "../access/index.js";
import type { Database } from "../db/index.js";

const HOUR_MS = 60 * 60_000;

/**
 * hub-core's own jobs. Their names start with `core.`, which no feature's job can, since a feature's job names have
 * no dot.
 */
export const createCoreJobs = (parts: { db: Database; now: () => number }): ScheduledJob[] => [
  {
    name: "core.expire-sessions",
    everyMs: HOUR_MS,
    run: async () => {
      await deleteExpiredSessions(parts.db, parts.now());
    },
  },
];
