import * as m0001 from "./0001-core-tables.js";
import * as m0002 from "./0002-projects-and-environments.js";
import * as m0003 from "./0003-project-keys.js";
import type { MigrationPackage } from "../migrator/index.js";

/** hub-core's migrations, in order; a new one is added at the end and a released one never changes. */
export const CORE_MIGRATIONS: MigrationPackage = { name: "core", migrations: [m0001, m0002, m0003] };

/** The tables with no organization's rows; every other table needs `org_id` under forced row-level security. */
export const GLOBAL_TABLES: readonly string[] = ["orgs", "users", "memberships", "sessions", "credentials", "settings"];
