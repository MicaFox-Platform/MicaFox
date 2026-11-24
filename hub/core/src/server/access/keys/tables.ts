import type { Generated } from "kysely";

/**
 * `credentials` as the project keys see it: a key is the row of kind `project-key`. The table has no organization
 * policy, so every query on it names `orgId`.
 */
export interface KeyCredentialsTable {
  id: Generated<string>;
  kind: "project-key";
  tokenHash: string;
  displayPrefix: string;
  name: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  createdBy: string | null;
  createdAt: Generated<Date>;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** The columns of `environments` a key needs. */
export interface EnvironmentRefTable {
  id: string;
  orgId: string;
  projectId: string;
}

/** The tables of this folder, for `$extendTables`; `Record` since Kysely wants an index signature. */
export type KeyTables = Record<"credentials", KeyCredentialsTable> & Record<"environments", EnvironmentRefTable>;
