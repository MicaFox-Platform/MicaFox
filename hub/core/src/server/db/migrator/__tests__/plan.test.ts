import { describe, expect, it } from "vitest";

import { findMissing, MigrationPackageError, UnknownMigrationError, validatePackages } from "../plan.js";
import type { Migration, MigrationPackage } from "../plan.js";

const migration = (name: string): Migration => ({ name, up: () => Promise.resolve() });

const debuggerPackage: MigrationPackage = {
  name: "debugger",
  migrations: [migration("0001-breakpoints"), migration("0002-snapshots"), migration("0003-statuses")],
};

describe("findMissing", () => {
  it("returns every migration of a package the database has not run, in the package's order", () => {
    const missing = findMissing(debuggerPackage, new Set(["0001-breakpoints"]));

    expect(missing.map((one) => one.name)).toEqual(["0002-snapshots", "0003-statuses"]);
  });

  it("returns nothing when the database is up to date", () => {
    const recorded = new Set(debuggerPackage.migrations.map((one) => one.name));

    expect(findMissing(debuggerPackage, recorded)).toEqual([]);
  });

  it("refuses a database that ran a migration this build does not have, saying a newer hub migrated it", () => {
    const recorded = new Set(["0001-breakpoints", "0004-from-a-newer-hub"]);

    expect(() => findMissing(debuggerPackage, recorded)).toThrow(UnknownMigrationError);
    expect(() => findMissing(debuggerPackage, recorded)).toThrow(/0004-from-a-newer-hub of debugger.*a newer hub/);
  });
});

describe("validatePackages", () => {
  it("accepts packages with distinct names and distinct migrations", () => {
    expect(() => {
      validatePackages([debuggerPackage, { name: "core", migrations: [migration("0001-breakpoints")] }]);
    }).not.toThrow();
  });

  it.each(["Core", "core_tables", "1core", "", "a".repeat(41)])("rejects the package name %j", (name) => {
    expect(() => {
      validatePackages([{ name, migrations: [] }]);
    }).toThrow(MigrationPackageError);
  });

  it("rejects two packages with one name, which would share a migrations table", () => {
    expect(() => {
      validatePackages([debuggerPackage, debuggerPackage]);
    }).toThrow("Two migration packages are named debugger");
  });

  it("rejects two migrations of one package with one name", () => {
    expect(() => {
      validatePackages([{ name: "core", migrations: [migration("0001-a"), migration("0001-a")] }]);
    }).toThrow("The package core has two migrations named 0001-a");
  });
});
