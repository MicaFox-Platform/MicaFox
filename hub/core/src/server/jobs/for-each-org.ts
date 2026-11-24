import type { Logger } from "pino";

import { listOrgIds } from "../access/index.js";
import type { Database } from "../db/index.js";
import type { Gate } from "../feature/index.js";

/** What a run over the organizations needs. */
export interface OrgRunParts {
  db: Database;
  gate: Gate;
  log: Logger;
}

/** Some organizations failed in a run; each was logged with its id. */
export class OrgRunError extends Error {
  constructor(
    readonly job: string,
    readonly failures: number,
  ) {
    super(`The job "${job}" failed in ${String(failures)} organization(s)`);
    this.name = "OrgRunError";
  }
}

/**
 * Runs `run` for each organization the gate lets use `feature`, one at a time, until `signal` aborts. An
 * organization that fails, or whose entitlement cannot be read, is logged and the next one still runs; the run then
 * fails with an `OrgRunError`.
 */
export const forEachEntitledOrg = async (
  parts: OrgRunParts,
  target: { job: string; feature: string; signal: AbortSignal },
  run: (orgId: string) => Promise<void>,
): Promise<void> => {
  let failures = 0;
  for (const orgId of await listOrgIds(parts.db)) {
    if (target.signal.aborted) {
      break;
    }
    try {
      if (await parts.gate.isEntitled(orgId, target.feature)) {
        await run(orgId);
      }
    } catch (error) {
      failures += 1;
      parts.log.error({ job: target.job, orgId, err: error }, "A job failed in an organization");
    }
  }
  if (failures > 0) {
    throw new OrgRunError(target.job, failures);
  }
};
