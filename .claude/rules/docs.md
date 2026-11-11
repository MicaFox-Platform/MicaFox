---
paths:
  - "docs/**"
  - "README.md"
---

# Docs

The reader is a developer integrating MicaFox, not us. Write for someone who has not seen the code. Short beats
complete: a doc that takes more than a few minutes to read gets split.

- One `#` title per file, ≤ 60 chars. Sentence case.
- One name per concept, the same in code and docs.
- Link, do not repeat: point to the ADR for "why", to `docs/api/` for "how to use".
- Code blocks always declare a language. Relative links between docs.
- Diagrams are plain text in a `text` code block, ≤ 120 chars wide, drawn with box-drawing characters
  (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ▶ ◀`). `──▶` is a call or data flow, `─ ─▶` an optional one; label every arrow. No Mermaid
  or images: the docs are read as raw text in terminals, editors and on npm.
- Keep each file's section structure below; write `None yet.` under a section that has no content.

## Overviews

`docs/architecture/overview.md`, `docs/api/overview.md` and the `overview.md` of a package folder give the whole
picture in a few minutes: they summarize and link, never repeat details. Every change in `docs/architecture/` or
`docs/api/` checks the overviews above the changed file in the same PR and fixes what no longer matches: diagrams,
packages, key flows, exports, environment variables and ADR lists.

## `docs/architecture/`

Only the decided design. No alternatives, no "we considered", no open questions: undecided topics go to
`/architect`. When a decision changes, rewrite the doc to the new design; the history lives in the ADRs. A draft
made from `.claude/templates/architecture.md` is input for `/architect` only and is never merged as a draft.

`overview.md` has the sections Components (diagram), Packages, Key flows, Decisions (ADR links).
`<component>.md` has the sections Purpose, Boundaries, Interactions (diagram), Layout (folder tree), Key flows,
Decisions. Layout is the decided folder tree of the component; a change that adds, moves or removes a folder or a
source file updates it in the same PR. A package that
is one component gets `<package>.md`; a package with several large components gets a folder `<package>/` with one
`<component>.md` per component (`sdk/connector.md`, `sdk/debugger.md`).

## `docs/api/`

`overview.md` has the sections Packages (a table: package, what to install it for, link) and Usage (which package
for which job). A package gets `<package>.md`. A package with several large parts gets a folder `<package>/`:
`overview.md` with the installation and the list of parts, and one `<part>.md` per part, named like its
architecture doc.

Copy `.claude/templates/api.md`. Sections Installation, Exports and Usage. Under Exports, one `###` per exported
symbol: signature, parameters, return value, errors, minimal example. A renamed or removed export keeps a one-line
note with the new name until the next major version. Usage shows one end-to-end example of the common case.

```md
<!-- Bad: discussion in an architecture doc -->

## Transport

We could use WebSocket or HTTP. WebSocket is probably better because...

<!-- Good -->

## Transport

The connector opens one WebSocket to the hub and keeps it alive with heartbeats. See
[ADR 0003](../adr/0003-use-websocket-between-the-sdk-and-the-hub.md).
```
