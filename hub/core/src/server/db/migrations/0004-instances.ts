import { sql } from "kysely";
import type { Kysely } from "kysely";

import { addOrgPolicy } from "../policies.js";

// The app instances that connected to an environment, one row per environment and `instanceId`, under row-level
// security. Online is not stored: the replica that holds the session knows it.
export const name = "0004-instances";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // The composite key keeps the organization and project of a row to its environment's, as for project keys
  await sql`create table instances (
    org_id uuid not null,
    project_id uuid not null,
    environment_id uuid not null,
    instance_id text not null,
    service text,
    labels jsonb not null default '{}',
    hostname text not null,
    pid integer not null,
    sdk_name text not null,
    sdk_version text not null,
    runtime_name text not null,
    runtime_version text not null,
    modules text[] not null default '{}',
    "commit" text,
    protocol_version integer not null,
    key_prefix text not null,
    connected_at timestamptz not null,
    last_seen_at timestamptz not null,
    primary key (environment_id, instance_id),
    foreign key (environment_id, project_id, org_id)
      references environments (id, project_id, org_id) on delete cascade
  )`.execute(db);
  // The oldest offline instance of an environment, and the expiry of every old one
  await sql`create index instances_environment_id_last_seen_at_idx on instances (environment_id, last_seen_at)`.execute(
    db,
  );
  await sql`create index instances_last_seen_at_idx on instances (last_seen_at)`.execute(db);
  await addOrgPolicy(db, "instances");
};
