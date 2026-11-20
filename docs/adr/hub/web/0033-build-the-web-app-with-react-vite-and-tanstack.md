# 0033. Build the web app with React, Vite and TanStack

## Status

Accepted · 2026-11-20

## Context

The hub's web app needs complex screens: trees of captured variables, long virtualized lists, filters kept in the
URL. Features add their own routes and screens to one shell. The hub serves it from its own origin in the same image,
and needs no server rendering. Contributors should find the stack familiar.

## Decision

We build the web app as a single-page app with React, bundled by Vite, routed by TanStack Router with a route tree
assembled in code from the features, and loading data through TanStack Query.

## Alternatives

- **Next.js** — its own server next to Fastify, or a custom server; server rendering the hub does not need, and a
  heavier image.
- **Solid or Svelte** — smaller bundles, but fewer ready components for the complex screens and fewer contributors.
- **React Router** — fine routing, but less type safety for parameters and search filters in the URL.

## Consequences

- Features ship React components and TanStack routes in their `./web` entry.
- Routes are built in code, so features compose them; routing by files does not apply.
- `pnpm dev` runs Vite with hot reload next to the server in watch mode.
