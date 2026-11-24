import type { Generated } from "kysely";

/** `projects` as Kysely sees it, with the columns in camelCase: `queries.ts` converts them. */
export interface ProjectsTable {
  id: Generated<string>;
  orgId: string;
  name: string;
  createdAt: Generated<Date>;
}

/** `environments` as Kysely sees it. */
export interface EnvironmentsTable {
  id: Generated<string>;
  orgId: string;
  projectId: string;
  name: string;
  createdAt: Generated<Date>;
}

/**
 * The tables of this folder, for `$extendTables`. Built with `Record` because Kysely wants an index signature,
 * which an interface lacks and the lint rule for object types turns a type literal into.
 */
export type TenancyTables = Record<"projects", ProjectsTable> & Record<"environments", EnvironmentsTable>;
