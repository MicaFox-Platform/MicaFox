import { sql } from "kysely";
import type { Kysely } from "kysely";

// hub-core's global tables, read by id, key or hash; projects and environments come in a later migration
export const name = "0001-core-tables";

// Sessions and every token kind: what access/ looks up by hash
const createSessionsAndCredentials = async (db: Kysely<unknown>): Promise<void> => {
  await sql`create table sessions (
    token_hash text primary key,
    user_id uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    last_used_at timestamptz not null default now()
  )`.execute(db);
  await sql`create index sessions_user_id_idx on sessions (user_id)`.execute(db);

  // One table for every token kind of ADR 0030: what a kind does not use stays null. A link is used once (used_at);
  // a key or token is revoked (revoked_at) and shows its first characters (display_prefix) and its last use
  await sql`create table credentials (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('project-key', 'personal-token', 'invite', 'reset', 'setup')),
    token_hash text not null unique,
    display_prefix text,
    name text,
    org_id uuid references orgs (id) on delete cascade,
    user_id uuid references users (id) on delete cascade,
    role text check (role in ('admin', 'member')),
    created_by uuid references users (id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    used_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz
  )`.execute(db);
  await sql`create index credentials_org_id_idx on credentials (org_id)`.execute(db);
};

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`create table orgs (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    created_at timestamptz not null default now()
  )`.execute(db);

  await sql`create table users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    name text not null,
    password_hash text not null,
    created_at timestamptz not null default now()
  )`.execute(db);
  await sql`create unique index users_email_key on users (lower(email))`.execute(db);

  await sql`create table memberships (
    user_id uuid not null references users (id) on delete cascade,
    org_id uuid not null references orgs (id) on delete cascade,
    role text not null check (role in ('owner', 'admin', 'member')),
    created_at timestamptz not null default now(),
    primary key (user_id, org_id)
  )`.execute(db);
  await sql`create index memberships_org_id_idx on memberships (org_id)`.execute(db);
  // One owner per organization
  await sql`create unique index memberships_one_owner on memberships (org_id) where role = 'owner'`.execute(db);

  await createSessionsAndCredentials(db);

  await sql`create table settings (
    key text primary key,
    value text not null
  )`.execute(db);
};
