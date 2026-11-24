import { sql } from "kysely";
import type { Kysely } from "kysely";

import { addOrgPolicy } from "../policies.js";

// An organization's projects and their environments, both under row-level security
export const name = "0002-projects-and-environments";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`create table projects (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references orgs (id) on delete cascade,
    name text not null,
    created_at timestamptz not null default now(),
    unique (id, org_id)
  )`.execute(db);
  // Names are unique within the organization, whatever their case
  await sql`create unique index projects_org_id_name_key on projects (org_id, lower(name))`.execute(db);
  await addOrgPolicy(db, "projects");

  // The composite key keeps an environment in its project's organization, so `org_id` cannot disagree with it
  await sql`create table environments (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null,
    project_id uuid not null,
    name text not null,
    created_at timestamptz not null default now(),
    foreign key (project_id, org_id) references projects (id, org_id) on delete cascade
  )`.execute(db);
  await sql`create unique index environments_project_id_name_key on environments (project_id, lower(name))`.execute(db);
  await sql`create index environments_org_id_idx on environments (org_id)`.execute(db);
  await addOrgPolicy(db, "environments");
};
