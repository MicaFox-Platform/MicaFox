import type { Kysely } from "kysely";
import type { Logger } from "pino";

import { grantToAppRole } from "./grants.js";
import { ensureHistory, readHistory, recordMigration } from "./history.js";
import { findMissing, validatePackages } from "./plan.js";
import type { Migration, MigrationPackage } from "./plan.js";
import { checkRowLevelSecurity } from "./rls-check.js";
import { openTarget } from "./target.js";

export { MigrationPackageError, UnknownMigrationError } from "./plan.js";
export type { Migration, MigrationPackage } from "./plan.js";
export { UnprotectedTablesError } from "./rls-check.js";

/** What the migrator needs to run the packages' migrations. */
export interface MigratorOptions {
  /** hub-core, then the features in the app's order, then the extension. */
  packages: readonly MigrationPackage[];
  /** The tables that hold no organization's rows, so need no `org_id` or RLS. */
  globalTables: readonly string[];
  /** The role the hub runs as, which gets the rights to what the migration role creates. */
  appRole: string;
  /** The migration role's URL. */
  url: string;
  /** On PGlite, the hub's one session, which it migrates through without a lock. */
  session: Kysely<unknown> | undefined;
  log: Logger;
}

// A migration and its record share one transaction, so a failure leaves neither
const runOne = async (db: Kysely<unknown>, packageName: string, migration: Migration): Promise<void> => {
  if (migration.transaction === false) {
    await migration.up(db);
    await recordMigration(db, packageName, migration.name);
    return;
  }
  await db.transaction().execute(async (trx) => {
    await migration.up(trx);
    await recordMigration(trx, packageName, migration.name);
  });
};

/**
 * Runs the missing migrations of every package in order, under a lock so two hubs never migrate at once. Throws
 * `UnknownMigrationError` before running anything when the database was migrated by a newer hub, and
 * `UnprotectedTablesError` afterwards when a table escapes row-level security.
 */
export const migrate = async (options: MigratorOptions, signal: AbortSignal): Promise<void> => {
  validatePackages(options.packages);
  const target = await openTarget(options, signal);
  try {
    // Read under the lock: what another hub ran while this one waited is not run twice
    const plans: Array<{ name: string; missing: Migration[] }> = [];
    for (const migrationPackage of options.packages) {
      await ensureHistory(target.db, migrationPackage.name);
      const recorded = await readHistory(target.db, migrationPackage.name);
      plans.push({ name: migrationPackage.name, missing: findMissing(migrationPackage, recorded) });
    }
    for (const { name, missing } of plans) {
      for (const migration of missing) {
        target.signal.throwIfAborted();
        await runOne(target.db, name, migration);
        options.log.info({ package: name, migration: migration.name }, "db.migrated");
      }
    }
    await checkRowLevelSecurity(target.db, options.globalTables);
    await grantToAppRole(target.db, options.appRole);
  } finally {
    await target.close();
  }
};
