import type { Kysely } from "kysely";

/** One migration: a module with an `up`, run once in the place it has in its package's list. */
export interface Migration {
  /** Unique within its package, such as `0001-core-tables`; it is what the package's migrations table records. */
  name: string;
  up: (db: Kysely<unknown>) => Promise<void>;
  /**
   * `false` for a statement a transaction refuses, such as `CREATE INDEX CONCURRENTLY`. A crash can then leave the
   * work done but not recorded, so `up` must be safe to run again.
   */
  transaction?: boolean;
}

/** The migrations of hub-core, of one feature or of the extension, in the order they run. */
export interface MigrationPackage {
  /** Lowercase letters, digits and dashes; it names the package's migrations table. */
  name: string;
  migrations: readonly Migration[];
}

/** The database recorded a migration this build does not have: a newer hub migrated it. */
export class UnknownMigrationError extends Error {
  constructor(packageName: string, migrationName: string) {
    super(
      `The database has the migration ${migrationName} of ${packageName}, which this hub does not know: a newer hub migrated it, so start that version or restore the backup taken before the upgrade`,
    );
    this.name = "UnknownMigrationError";
  }
}

/** The packages handed to the migrator cannot be told apart in the database. */
export class MigrationPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationPackageError";
  }
}

const PACKAGE_NAME = /^[a-z][a-z\d-]{0,39}$/;

/** Fails on a package name that is not usable in a table name, or on a name two packages or two migrations share. */
export const validatePackages = (packages: readonly MigrationPackage[]): void => {
  const packageNames = new Set<string>();
  for (const { name, migrations } of packages) {
    if (!PACKAGE_NAME.test(name)) {
      throw new MigrationPackageError(`The migration package name ${name} is not lowercase letters, digits and dashes`);
    }
    if (packageNames.has(name)) {
      throw new MigrationPackageError(`Two migration packages are named ${name}`);
    }
    packageNames.add(name);
    const migrationNames = new Set<string>();
    for (const migration of migrations) {
      if (migrationNames.has(migration.name)) {
        throw new MigrationPackageError(`The package ${name} has two migrations named ${migration.name}`);
      }
      migrationNames.add(migration.name);
    }
  }
};

/** The migrations of `migrationPackage` the database has not run, in order; throws when it ran one that is not listed. */
export const findMissing = (migrationPackage: MigrationPackage, recorded: ReadonlySet<string>): Migration[] => {
  const known = new Set(migrationPackage.migrations.map((migration) => migration.name));
  for (const name of recorded) {
    if (!known.has(name)) {
      throw new UnknownMigrationError(migrationPackage.name, name);
    }
  }
  return migrationPackage.migrations.filter((migration) => !recorded.has(migration.name));
};
