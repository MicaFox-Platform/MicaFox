import type { ColumnType } from "kysely";

/** `instances` as Kysely sees it, with the columns in camelCase: `queries.ts` converts them. */
export interface InstancesTable {
  orgId: string;
  projectId: string;
  environmentId: string;
  instanceId: string;
  service: string | null;
  /** Read as an object; written as JSON text, which is how the drivers take a `jsonb` value. */
  labels: ColumnType<Record<string, string>, string, string>;
  hostname: string;
  pid: number;
  sdkName: string;
  sdkVersion: string;
  runtimeName: string;
  runtimeVersion: string;
  modules: string[];
  commit: string | null;
  protocolVersion: number;
  keyPrefix: string;
  connectedAt: Date;
  lastSeenAt: Date;
}

/** `environments` as the list needs it, to tell that an environment of the organization exists. */
export interface EnvironmentIdTable {
  id: string;
}

/** The tables of this folder, for `$extendTables`; `Record` since Kysely wants an index signature. */
export type InstanceTables = Record<"instances", InstancesTable> & Record<"environments", EnvironmentIdTable>;
