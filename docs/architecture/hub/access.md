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
├── index.ts          the access plugin: the origin check, the open setup and login, the actor of other routes
├── authorization/    who may do what
│   ├── can.ts        can(actor, action, resource) for the features the hub runs, and the roles
│   └── request-context.ts  the actor resolver, and what a route gets for an organization
├── tenancy/          organizations, projects, environments, memberships
│   ├── index.ts      adds the project and environment routes
│   ├── project-routes.ts, environment-routes.ts
│   ├── queries.ts    the Kysely queries, paging and the 409 on a taken name
│   └── names.ts, schemas.ts, tables.ts
├── setup/            the setup token and the first owner
│   ├── index.ts      exports the start-up step and the route
│   ├── setup-token.ts  makes the token of a start, stores its hash and logs it once
│   ├── setup-route.ts  POST /api/v1/setup
│   └── queries.ts    the owner check, the token's hash and claiming the hub in one transaction
├── sessions/         login, logout, the cookie, the origin check
│   ├── index.ts      what the access plugin and setup use
│   ├── cookie.ts     the cookie's name and attributes, reading it, and the origin check
│   ├── resolver.ts   the actor of a request from its cookie: 7 and 30 days, the last use
│   ├── login.ts      the throttle, scrypt, the same 401 for every failure
│   └── session-routes.ts, schemas.ts, queries.ts, dependencies.ts
├── password/         scrypt hashes, at most 4 at once, and the hash that replaces a weaker one
├── throttle/         the limit per IP of the routes that check a secret, and the backoff per email
├── tokens/           createToken and hashToken: opaque prefixed tokens (ADR 0030)
├── global-tables/    the Kysely types of the tables without an organization: users, sessions, credentials
├── invites/          invites and reset links
├── keys/             project keys: create, list, revoke, look up
│   ├── index.ts      the key lookup, and what the access plugin uses
│   ├── key-routes.ts  list, create and revoke
│   ├── revoke-hooks.ts  the listeners that run after a revoke
│   ├── last-use.ts   the last use of keys, noted in memory and written by a core job every minute
│   └── queries.ts, schemas.ts, tables.ts
└── entitlements/     the gate entitlements(orgId), over the sources ee/hub registers
    ├── index.ts      what the hub and the feature gate use
    ├── entitlements.ts  the union of the sources, cached 60 s per organization, at most 10,000
    └── entitlement-routes.ts  GET /api/v1/orgs/{orgId}/entitlements
```

## Key flows

### Finding the actor

1. The hub is given an `ActorResolver`, which reads a request and answers the actor, a user with their memberships, or
   nobody. Nobody is 401 `unauthenticated` before the request's schema is checked. The hub's own reads the
   [session cookie](#logging-in); tests pass a resolver of their own, never one the hub would use. Only the setup
   and the login are open to nobody.
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
   403, and the route has the same limit per IP as the login. A token the operator gave in `MICAFOX_SETUP_TOKEN` is
   never printed.
3. Setup creates the organization, the owner and a session, deletes the token, and `/api/v1/setup` answers 404 from
   then on. Nobody else can claim a fresh hub, because the token is only in its log.
4. In [test mode](server.md#running-in-test-mode) the owner and a project are seeded instead, and no setup token
   exists.

### Logging in

1. `POST /api/v1/session` with email and password. Each route that checks a secret (setup, login, password change)
   lets an IP make 100 attempts in 10 minutes, each route on its own, through `@fastify/rate-limit`
   ([ADR 0040](../../adr/hub/access/0040-limit-attempts-per-ip-with-fastify-rate-limit.md)); it counts every
   request to the route, a malformed one too, after the origin check and, for the password change, after the actor.
   An IPv6 address counts with its /64. After 5 failures for one email, an attempt that comes before the wait is
   over is refused at once with 429 and `Retry-After`: 1 s after the 5th failure, doubling with each one, up to a
   minute. An attempt counts as a failure until its password is checked, so parallel guesses cannot all pass; an
   unknown email is counted like a known one, and a failure is forgotten after an hour without another. The counters
   live in each replica's memory, at most 10,000 IPs per route and 10,000 emails, the least recently used dropped
   first.
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
3. Revoking a key drops it from every cache and closes its SDK sessions with 1008: access runs the listeners added
   with `onKeyRevoked` once the revoke is committed, and the SDK endpoint adds the one that closes the sessions. A
   listener that fails is logged and never fails the request. Creating and revoking are `info` security events,
   `key.created` and `key.revoked`, with the key's prefix and never its token.
4. The SDK endpoint finds a key only by its hash, with `lookupKey(token)`, which gives its organization, project and
   environment, and nothing for a revoked or unknown token. The ids sit on the key's row, so the lookup needs no
   organization scope. Token formats: [ADR 0030](../../adr/hub/access/0030-use-opaque-prefixed-tokens-stored-as-hashes.md).

### Checking entitlements

1. `entitlements(orgId).has(name)` answers from the sources the extension registers, cached for 60 s per
   organization, the oldest dropped past 10,000; a failing source is not cached and fails the question. S2 has none,
   so it answers no; Cloud subscriptions (S5) and offline licence keys (S7) add sources. Core features never ask.
2. A licence key is a JSON payload with `kid`, features, seats and `expiresAt`, signed with ed25519 and checked
   offline against public keys built into the image. When it expires, its features turn off and their data stays.
3. `GET /api/v1/orgs/{orgId}/entitlements` (any member; `entitlement.read`) tells the web app what to show. A change publishes
   `entitlements.changed` and closes the organization's SDK sessions with 1001; the source that publishes it drops the
   organization's cached answer first, so the reconnect agrees on the new modules. Why:
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
- [0040. Limit attempts per IP with @fastify/rate-limit](../../adr/hub/access/0040-limit-attempts-per-ip-with-fastify-rate-limit.md)
- [0028. Isolate organizations with row-level security](../../adr/hub/database/0028-isolate-organizations-with-row-level-security.md)
