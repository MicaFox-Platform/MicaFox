# 0025. Build the hub server on Fastify with TypeBox schemas

## Status

Accepted · 2026-11-20

## Context

Each hub feature brings its own routes and must not see the others' state. The HTTP API is public, so it needs
validated input, responses that never leak extra fields and an OpenAPI description. The web app should validate
forms with the same schemas as the server. The SDK endpoint checks many small messages a second, and the hub should
stay light on a 1 vCPU machine.

## Decision

We build the hub server on Fastify, with each feature registered as an encapsulated plugin, and write every schema
of the server and the web app in TypeBox, which Fastify validates and serializes with directly and from which the
OpenAPI description is generated.

## Alternatives

- **Hono** — lighter and built on web standards, but plugins do not encapsulate state, and WebSocket on Node needs
  an adapter.
- **NestJS** — decorators and dependency injection add weight and indirection a small hub does not need.
- **Zod 4 instead of TypeBox** — friendlier to write, but JSON Schema is a conversion rather than the source, Fastify
  needs an adapter, and the web bundle grows.
- **Valibot instead of TypeBox** — smallest bundle, thinner ecosystem around Fastify and OpenAPI.

## Consequences

- A feature's routes are a Fastify plugin; its schemas live in the package's `./schema` entry, shared by its server
  and web parts.
- Response schemas drop fields they do not list, and validators are compiled once.
- pino, Fastify's logger, is the hub's logger.
- The hub depends on Fastify and its plugins for WebSocket, static files, security headers and OpenAPI.
