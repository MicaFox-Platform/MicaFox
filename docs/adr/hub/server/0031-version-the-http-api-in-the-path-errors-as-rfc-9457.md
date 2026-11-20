# 0031. Version the HTTP API in the path, errors as RFC 9457

## Status

Accepted · 2026-11-20

## Context

The web app, the CLI, MCP tools, the test kit and users' own scripts call the hub's HTTP API, and the hub promises
it stays stable from its first release. Errors must be machine-readable without parsing messages. Lists can grow to
many thousands of snapshots. Curl and log lines should show which version a request used.

## Decision

We serve the public API under `/api/v1` as REST with an OpenAPI description, return errors as RFC 9457
`application/problem+json` with a stable `type`, page lists with an opaque cursor, and move a breaking change to
`/api/v2` while `/api/v1` stays for one more minor version; routes only the web app uses live under
`/api/internal` and are not public.

## Alternatives

- **The version in a header** — invisible in URLs and logs, and awkward in curl and scripts.
- **tRPC** — shared types with the web app for free, but no public HTTP API for the CLI, MCP and scripts.
- **GraphQL** — one more language for users and a heavier server for a small API.
- **Offset pagination** — slow on large tables, and rows shift between pages while snapshots arrive.

## Consequences

- Problem types look like `urn:micafox:problem:<code>` and never change once released.
- `/api/v1/openapi.json` is generated from the same TypeBox schemas the server validates with.
- Adding a field, an endpoint or an optional header such as `Idempotency-Key` is compatible; renaming or removing
  one needs `/api/v2`.
