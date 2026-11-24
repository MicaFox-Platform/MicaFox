import type { Logger } from "pino";

import { hasOwner, replaceSetupToken } from "./queries.js";
import type { Database } from "../../db/index.js";
import { globalTables } from "../global-tables/index.js";
import { createToken, hashToken } from "../tokens/index.js";

/** What the start-up step needs. */
export interface SetupTokenOptions {
  db: Database;
  log: Logger;
  publicUrl: () => string;
  /** `MICAFOX_SETUP_TOKEN`: used instead of a new one, for automation. */
  configuredToken: string | undefined;
}

/**
 * While no owner exists, makes the setup token of this start, stores its hash and logs it once with the URL of
 * `/setup`: it is the only proof that whoever sets the hub up can read its log. A token the operator configured is
 * never printed.
 */
export const ensureSetupToken = async (options: SetupTokenOptions): Promise<void> => {
  const db = globalTables(options.db.global);
  if (await hasOwner(db)) {
    return;
  }
  const token = options.configuredToken ?? createToken("mfx_setup_");
  await replaceSetupToken(db, hashToken(token));
  const setupUrl = `${options.publicUrl()}/setup`;
  const instruction =
    options.configuredToken === undefined ? `the setup token ${token}` : "the token you gave in MICAFOX_SETUP_TOKEN";
  options.log.info(
    { event: "setup.token-created", setupUrl },
    `The hub has no owner yet. Open ${setupUrl} with ${instruction}`,
  );
};
