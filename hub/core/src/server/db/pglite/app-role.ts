import type { PGlite } from "@electric-sql/pglite";

/** The role the hub runs as inside PGlite, as it would connect as an app role to Postgres. */
export const APP_ROLE = "micafox_app";

// PGlite opens every session as the superuser `postgres`, which bypasses row-level security. The hub switches to a
// role without it, so the same policies hold as on Postgres. A folder opened again already has the role. The
// app role runs the migrations, so it may create tables in public, which Postgres 15+ no longer grants to everyone.
const BECOME_APP_ROLE = `
  do $$ begin
    if not exists (select from pg_roles where rolname = '${APP_ROLE}') then
      create role ${APP_ROLE} nosuperuser nobypassrls nologin;
    end if;
  end $$;
  grant usage, create on schema public to ${APP_ROLE};
  set role ${APP_ROLE};
`;

/** Creates the app role when it is missing and makes it the session's role. */
export const becomeAppRole = async (pglite: PGlite): Promise<void> => {
  await pglite.exec(BECOME_APP_ROLE);
};
