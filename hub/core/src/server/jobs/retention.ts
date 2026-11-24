import type { Logger } from "pino";

import { forEachEntitledOrg } from "./for-each-org.js";
import type { OrgRunParts } from "./for-each-org.js";
import type { ScheduledJob } from "./scheduler.js";
import type { Database } from "../db/index.js";
import type { Registered, RetentionPolicy } from "../feature/index.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
// Small enough that one batch's transaction holds its locks only briefly
const BATCH_ROWS = 1000;

/** What the retention runner needs besides a run over the organizations. */
export interface RetentionParts extends OrgRunParts {
  /** `MICAFOX_RETENTION_<NAME>_DAYS` by policy name, lower case with `_` for `-`. */
  retentionDays: Readonly<Record<string, number>>;
  now: () => number;
}

const settingKeyOf = (policy: string): string => policy.replaceAll("-", "_");

// Each batch is a transaction of its own, so the rows go away a batch at a time; a stop or the time limit ends the
// run between two batches
const deleteInBatches = async (
  db: Database,
  policy: RetentionPolicy,
  batch: { orgId: string; olderThan: Date; signal: AbortSignal },
): Promise<number> => {
  const { orgId, olderThan, signal } = batch;
  let total = 0;
  while (!signal.aborted) {
    // Every organization's batches each hour: the run logs one summary line instead
    const deleted = await db.system(
      `retention ${policy.name}`,
      async (trx) => await policy.run({ orgId, olderThan, limit: BATCH_ROWS, db: trx }),
      { logLevel: "debug" },
    );
    total += deleted;
    if (deleted < BATCH_ROWS) {
      break;
    }
  }
  return total;
};

/**
 * A feature's retention policy as the scheduler runs it: every hour, for each organization that may use the feature,
 * deleting what is older than the operator's days, or the policy's own.
 */
export const scheduleRetention = (registered: Registered<RetentionPolicy>, parts: RetentionParts): ScheduledJob => {
  const { feature, part: policy } = registered;
  const days = parts.retentionDays[settingKeyOf(policy.name)] ?? policy.maxAgeDays;
  const name = `retention.${policy.name}`;
  return {
    name,
    everyMs: HOUR_MS,
    run: async (signal) => {
      const olderThan = new Date(parts.now() - days * DAY_MS);
      let rows = 0;
      try {
        await forEachEntitledOrg(parts, { job: name, feature, signal }, async (orgId) => {
          rows += await deleteInBatches(parts.db, policy, { orgId, olderThan, signal });
        });
      } finally {
        parts.log.info({ job: name, rows }, "Retention deleted old rows");
      }
    },
  };
};

/** Warns of each `MICAFOX_RETENTION_<NAME>_DAYS` that no policy reads, such as a misspelt name. */
export const warnUnusedRetentionDays = (
  policies: ReadonlyArray<Registered<RetentionPolicy>>,
  retentionDays: Readonly<Record<string, number>>,
  log: Logger,
): void => {
  const used = new Set(policies.map(({ part }) => settingKeyOf(part.name)));
  for (const key of Object.keys(retentionDays)) {
    if (!used.has(key)) {
      log.warn(
        { setting: `MICAFOX_RETENTION_${key.toUpperCase()}_DAYS` },
        "The setting names no retention policy; it is ignored",
      );
    }
  }
};
