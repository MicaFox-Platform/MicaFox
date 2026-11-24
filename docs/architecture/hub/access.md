# Hub access

## Purpose

Who is who in a hub and what they may do: organizations, projects and environments, users and roles, the first
run, logging in, invites, password resets, project keys and entitlements, with the threat model they answer.

## Boundaries

- Owns:
  - the model organization → project → environment, users, memberships and roles, and `can()`;
  - the setup token, sessions and their cookie, the origin check, login rate limits;
  - invites, reset links and project keys;
  - `entitlements(orgId)`, the gate over the sources the extension registers.
- Does not own: isolating rows by organization: [database](database.md#scoping-a-query); the actions a feature
  defines, which it checks through `can()`.
- Split: `hub/core` holds login, sessions, invites, password resets, project keys, the base roles and the
  entitlement gate. `ee/hub` adds the paid parts behind it: billing and Cloud sign-up, the licence-key entitlement
  source, SSO and SCIM, fine-grained roles and the audit log.
- Constraints:
  - Passwords, session ids, keys and links are stored only as hashes; S2 encrypts nothing and needs no secret but
    the database's.
  - No email: invites and resets are links an admin hands over.

## Interactions

```text
┌─────────┐ POST /api/v1/session    ┌──────────────── access ────────────────┐ hashes ┌───────────────────┐
│ Browser │────────────────────────▶│ rate limit · scrypt · new session      │───────▶│ users, sessions   │
│         │◀────────────────────────│ Set-Cookie                             │        │ memberships       │
│         │ request + cookie        │ session → actor → membership → can()   │───────▶│                   │
│         │────────────────────────▶│ origin check on changing requests      │        │                   │
└─────────┘                         └────────────────────────────────────────┘        │ credentials       │
┌─────────┐ Bearer mfx_pk_…         ┌────────────────────────────────────────┐ hash   │                   │
│ SDK     │────────────────────────▶│ SDK endpoint: key → org, project, env  │───────▶│                   │
└─────────┘                         └────────────────────────────────────────┘        └───────────────────┘
```

### Model

- An **organization** holds **projects**, and a project holds **environments**, such as `production` and
  `staging`; a new project starts with `production`. Names are unique within their parent. A self-hosted hub has
  one organization, created at setup.
- A **user** belongs to organizations through **memberships**, each with one role:
  - **owner** — one per organization, every right; S2 cannot remove or demote the owner;
  - **admin** — members, invites, projects, environments and keys;
  - **member** — uses the features and reads the settings.
- Names are stored in Unicode NFC and trimmed, 1 to 64 characters, without control or invisible characters (format
  characters such as a zero-width space, line and paragraph separators), and unique within their parent whatever
  their case: a unique index on `lower(name)`, so a taken name is 409 `conflict`.
- Every check goes through `can(actor, action, resource)`. In S2 it knows only "admin or owner" and "member";
  features name their actions `<feature>.<action>`, which every member may do for the features the hub runs. Any other
  action, such as a core action it does not list or a feature the hub does not run, is refused.

## Layout

```text
hub/core/src/server/access/
├── index.ts          the access plugin: the actor of each request, 401 without one, and the routes that need it
├── authorization/    who may do what
│   ├── can.ts        can(actor, action, resource) for the features the hub runs, and the roles
│   └── request-context.ts  the actor resolver, and what a route gets for an organization
├── tenancy/          organizations, projects, environments, memberships
│   ├── index.ts      adds the project and environment routes
│   ├── project-routes.ts, environment-routes.ts
│   ├── queries.ts    the Kysely queries, paging and the 409 on a taken name
│   └── names.ts, schemas.ts, tables.ts
├── setup/            the setup token and the first owner
├── sessions/         login, logout, the cookie, the origin check, rate limits, scrypt
├── invites/          invites and reset links
├── keys/             project keys: create, list, revoke, look up, last use
└── entitlements/     the gate entitlements(orgId), over the sources ee/hub registers
```

## Key flows

### Finding the actor

1. The hub is given an `ActorResolver`, which reads a request and answers the actor, a user with their memberships, or
   nobody. Nobody is 401 `unauthenticated` before the request's schema is checked. Until [sessions](#logging-in)
   exist the default answers nobody; tests pass a resolver of their own, never one the hub would use.
2. A route under `/orgs/{orgId}` takes the actor's membership of that organization, or answers 404 so nothing says the
   organization exists, and gets `db.forOrg` of it. Then `can()` decides: a member on an admin action is 403
   `forbidden`.
3. A route with only an id in its path, such as `/projects/{projectId}`, has no organization to look in. It tries each
   of the actor's organizations through `db.forOrg`, in order; the first that holds the id answers, and when none does
   it is 404. A member who may not do the action gets 403, and a bad body 400, only from the organization that holds
   the id.

### Creating the first owner

1. While no owner exists, each start creates a setup token, `mfx_setup_…`, stores its hash and prints it once with
   the URL of `/setup`; `MICAFOX_SETUP_TOKEN` gives one instead, for automation.
2. `/setup` asks for the token, the organization's name and the owner's name, email and password. A wrong token is
   403 and counts toward the login rate limit.
3. Setup creates the organization, the owner and a session, deletes the token, and `/api/v1/setup` answers 404 from
   then on. Nobody else can claim a fresh hub, because the token is only in its log.
4. In [test mode](server.md#running-in-test-mode) the owner and a project are seeded instead, and no setup token
   exists.

### Logging in

1. `POST /api/v1/session` with email and password. Each IP gets 100 attempts in 10 minutes; after 5 failures for one
   email, each next attempt waits longer, up to a minute. The counters live in each replica's memory.
2. scrypt checks the password (N = 2¹⁵, r = 8, p = 3, at most 4 at once); an unknown email costs the same time, and
   both answer 401 `invalid-credentials`. A hash with weaker parameters is replaced on success.
3. A session is 32 random bytes in the cookie and their SHA-256 in `sessions`, valid for 7 days without use and 30
   days at most. The cookie is `__Host-micafox_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`; on
   `http://localhost` it is `micafox_session` without `Secure`. Over HTTP on any other host the hub does not start.
4. Each request finds the session by the cookie's hash and updates its last use at most once a minute; an expired
   one is 401 `session-expired`, and the web app goes to the login page.
5. A `POST`, `PUT`, `PATCH` or `DELETE` with the cookie needs an `Origin` equal to `MICAFOX_PUBLIC_URL`'s, or it is
   403 `origin-mismatch`. Requests with a bearer token carry no cookie and need no origin.
6. `DELETE /api/v1/session` logs out; `DELETE /api/v1/sessions` logs out everywhere and ends the user's events
   streams. Changing a password ends every other session. Why sessions in Postgres:
   [ADR 0029](../../adr/hub/access/0029-keep-ui-sessions-in-postgres-behind-a-cookie.md).

### Inviting a user

1. An admin creates an invite with a role, admin or member: a link `<public URL>/invite/mfx_inv_…`, shown once,
   valid for 7 days and once. Open invites are listed and can be revoked.
2. The invitee sets a name, email and password, or logs in when the email already has an account, and joins.
3. An admin changes a member's role or removes them; a removed member loses access at their next request, because
   every request checks the membership.

### Resetting a password

1. `micafox-hub reset-password <email>` prints a link `<public URL>/reset/mfx_rst_…`, and an admin can make one for a
   member in the UI; it is valid for an hour and once.
2. The user sets a new password, and all their sessions end.

### Managing project keys

1. An admin creates a key for an environment: `mfx_pk_` and 43 characters, shown once with the hub URL to copy.
   The hub stores its SHA-256, its first 12 characters to show, a name, who created it, when, and its last use.
2. An environment has up to 5 active keys, so a key is rotated by adding the new one, deploying it and revoking the
   old one ([ADR 0006](../../adr/sdk/connector/0006-authenticate-to-the-hub-with-a-bearer-token.md)).
3. Revoking a key drops it from every cache and closes its SDK sessions with 1008.
4. The SDK endpoint finds a key only by its hash, which gives the organization, project and environment. Token
   formats: [ADR 0030](../../adr/hub/access/0030-use-opaque-prefixed-tokens-stored-as-hashes.md).

### Checking entitlements

1. `entitlements(orgId).has(name)` answers from the sources the hub runs with, cached for 60 s. S2 has none, so it
   answers no; Cloud subscriptions (S5) and offline licence keys (S7) add sources. Core features never ask.
2. A licence key is a JSON payload with `kid`, features, seats and `expiresAt`, signed with ed25519 and checked
   offline against public keys built into the image. When it expires, its features turn off and their data stays.
3. `GET /api/v1/orgs/{orgId}/entitlements` tells the web app what to show. A change publishes
   `entitlements.changed` and closes the organization's SDK sessions with 1001. Why:
   [ADR 0024](../../adr/hub/access/0024-gate-paid-features-by-entitlements-on-the-server.md).

### Threat model

Snapshots hold app data, so the hub guards who reads them and who can claim the hub.

| Threat                             | What it gives                                        | Answer                                                                                  |
| ---------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Claiming a fresh hub               | the owner's rights                                   | the setup token, printed only in the hub's log                                          |
| Another organization in Cloud      | its snapshots                                        | RLS in Postgres, `db.forOrg`, an isolation test of every endpoint and the events stream |
| A stolen project key               | breakpoint files and lines; fake snapshots; no reads | revoking, its last use, limits per key                                                  |
| A stolen session                   | the user's access                                    | `HttpOnly`, 7 days without use, logging out everywhere                                  |
| A forged request from another site | a change in the user's name                          | `SameSite=Lax` and the origin check                                                     |
| Guessing passwords                 | an account                                           | rate limits per IP and email, scrypt                                                    |
| A leaked database                  | hashes and app data                                  | only hashes of secrets; disk encryption is the operator's                               |
| SQL injection setting another org  | another organization's rows                          | Kysely parameters only; with a separate owner role, the app role cannot turn RLS off    |
| Test mode on a reachable port      | keyless SDK connections, the generated password      | only on PGlite, so it never holds real data; a warning at start                         |

## Decisions

- [0024. Gate paid features by entitlements on the server](../../adr/hub/access/0024-gate-paid-features-by-entitlements-on-the-server.md)
- [0029. Keep UI sessions in Postgres behind a cookie](../../adr/hub/access/0029-keep-ui-sessions-in-postgres-behind-a-cookie.md)
- [0030. Use opaque prefixed tokens stored as hashes](../../adr/hub/access/0030-use-opaque-prefixed-tokens-stored-as-hashes.md)
- [0028. Isolate organizations with row-level security](../../adr/hub/database/0028-isolate-organizations-with-row-level-security.md)
