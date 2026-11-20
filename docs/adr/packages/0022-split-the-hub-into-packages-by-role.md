# 0022. Split the hub into packages by role

## Status

Accepted · 2026-11-20

## Context

The hub is one application, but its parts have different readers and licences. The SDK and the protocol are MIT
because they run inside or next to other people's apps. The hub's core should be open, yet protected from being
taken closed and sold as a service. Paid features must live in `ee/` under a proprietary licence and never leak into
the open code. More features follow the debugger (error tracking, logpoints), each with server code, screens and
migrations, and the hub's look should be reusable outside the hub, such as on the website.

## Decision

We split the hub into private packages by role: `@micafox/ui` (MIT), `@micafox/hub-core` (AGPL-3.0), one package per
feature such as `@micafox/hub-debugger` (AGPL-3.0), `@micafox/hub-ee` in `ee/hub` (proprietary, source-available),
and the app `@micafox/hub` (AGPL-3.0); dependencies point from the UI kit through the core and the features to the
extension and the app, and nothing but the app imports `ee/`.

## Alternatives

- **One `packages/hub` with folders** — an MIT folder inside an AGPL package muddles the licences, boundaries hold
  only by path rules, and the UI kit cannot be reused on its own.
- **A server package and a web package** — a feature would be split across two packages, and adding one would touch
  both; the feature contract treats server and screens as one unit.
- **MIT for the whole hub** — a cloud provider could ship a closed, modified hub as a service.

## Consequences

- Each package has its own `LICENSE` and `license` field; the root `LICENSE` stays MIT for files no package or `ee/`
  covers. `ee/LICENSE` holds the owner's proprietary terms.
- External pull requests into AGPL packages need a signed CLA that lets the owner relicense the contribution, since
  the official image ships it next to `ee/`. `ee/` takes no external pull requests.
- CI rejects third-party dependencies under GPL, AGPL or SSPL in the hub packages, and anything but permissive
  licences in `@micafox/ui`.
- The running hub links to its source, as AGPL-3.0 section 13 asks.
- ESLint enforces the dependency direction; five packages to keep in the workspace instead of one.
