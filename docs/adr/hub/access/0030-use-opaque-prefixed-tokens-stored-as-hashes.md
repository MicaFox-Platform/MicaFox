# 0030. Use opaque prefixed tokens stored as hashes

## Status

Accepted · 2026-11-20

## Context

The hub issues several secrets: project keys the SDK sends on every connection
([ADR 0006](../../sdk/connector/0006-authenticate-to-the-hub-with-a-bearer-token.md)), personal API tokens for the
CLI and MCP, invite and password reset links, and the setup token. Users copy them into deployments and scripts.
A leaked database must not reveal them, revoking one must take effect at once, a key must rotate without downtime,
and a leaked token should be recognizable by people and secret scanners.

## Decision

We issue every token as 32 random bytes in base64url behind a prefix that names its kind (`mfx_pk_` for project
keys, `mfx_pat_` for personal tokens, `mfx_inv_`, `mfx_rst_` and `mfx_setup_` for links), show it once, store only
its SHA-256 and find it by that hash.

## Alternatives

- **JWT** — long, exposes its claims, and revoking it still needs the database.
- **Encrypting tokens instead of hashing them** — a leaked key decrypts every token.
- **A slow password hash such as scrypt for tokens** — 256 random bits need no stretching, and the SDK endpoint
  looks keys up on every connection.

## Consequences

- The UI shows a token's first 12 characters to tell them apart; a lost token is replaced, never shown again.
- An environment can hold up to 5 active project keys, so a key rotates without downtime; revoking one closes its
  SDK sessions.
- The prefixes are public API: they appear in the docs and in users' secret stores.
