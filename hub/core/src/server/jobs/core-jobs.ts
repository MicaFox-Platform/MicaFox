import type { ScheduledJob } from "./scheduler.js";
import { deleteExpiredSessions } from "../access/index.js";
import type { KeyUses } from "../access/index.js";
import type { Database } from "../db/index.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * hub-core's own jobs. Their names start with `core.`, which no feature's job can, since a feature's job names have
 * no dot.
 */
export const createCoreJobs = (parts: { db: Database; now: () => number; keyUses: KeyUses }): ScheduledJob[] => [
  {
    name: "core.expire-sessions",
    everyMs: HOUR_MS,
    run: async () => {
      await deleteExpiredSessions(parts.db, parts.now());
    },
  },
  {
    name: "core.write-key-last-use",
    everyMs: MINUTE_MS,
    run: async () => {
      await parts.keyUses.write();
    },
  },
];
