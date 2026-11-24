import { forEachEntitledOrg } from "./for-each-org.js";
import type { OrgRunParts } from "./for-each-org.js";
import type { ScheduledJob } from "./scheduler.js";
import type { FeatureJob, Registered } from "../feature/index.js";

/** A feature's job as the scheduler runs it: once per run for each organization that may use the feature. */
export const scheduleFeatureJob = (registered: Registered<FeatureJob>, parts: OrgRunParts): ScheduledJob => {
  const { feature, part: job } = registered;
  return {
    name: job.name,
    everyMs: job.everyMs,
    run: async (signal) => {
      await forEachEntitledOrg(parts, { job: job.name, feature, signal }, async (orgId) => {
        await job.run({
          orgId,
          signal,
          log: parts.log.child({ job: job.name, orgId }),
          forOrg: async (run) => await parts.db.forOrg(orgId, run),
        });
      });
    },
  };
};
