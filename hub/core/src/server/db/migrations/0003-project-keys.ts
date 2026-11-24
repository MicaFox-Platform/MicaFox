import { sql } from "kysely";
import type { Kysely } from "kysely";

// A project key belongs to one environment: the ids sit on `credentials`, which has no organization policy, so the
// SDK endpoint finds a key by its hash and reads where it leads without a scoped transaction
export const name = "0003-project-keys";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // The target of the composite key below, as `projects (id, org_id)` is for environments
  await sql`alter table environments add unique (id, project_id, org_id)`.execute(db);
  // One composite key, so a key's organization and project cannot disagree with its environment's: the SDK endpoint
  // trusts them. A row of another kind leaves the columns null, which a composite key does not check
  await sql`alter table credentials
    add column project_id uuid,
    add column environment_id uuid,
    add foreign key (environment_id, project_id, org_id)
      references environments (id, project_id, org_id) on delete cascade`.execute(db);
  await sql`create index credentials_environment_id_idx on credentials (environment_id)`.execute(db);
  await sql`alter table credentials add constraint credentials_project_key_shape check (
    kind <> 'project-key' or (
      org_id is not null and project_id is not null and environment_id is not null
      and name is not null and display_prefix is not null
    )
  )`.execute(db);
};
